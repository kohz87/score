import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { Link, useInRouterContext, useNavigate } from 'react-router'
import remarkGfm from 'remark-gfm'
import { copyText } from '../../data/clipboard.ts'
import { normalizeBullets } from './bullets.ts'
import { normalizeTables } from './tables.ts'
import { normalizeLanguage, tokenize } from './highlight.ts'
import { isWorkspaceHref, parseWorkspaceLink, type WorkspaceTarget } from './workspace-link.ts'

/** Shows `text` at most once per animation frame while it streams, so a fast reply does not re-parse on every chunk. */
export function useFrameText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text)
  useEffect(() => {
    if (!streaming) return
    const frame = requestAnimationFrame(() => setShown(text))
    return () => cancelAnimationFrame(frame)
  }, [text, streaming])
  return streaming ? shown : text
}

function codeOf(children: ReactNode): { text: string; language: string | null } | null {
  const child = Children.toArray(children)[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const raw = child.props.children
  const text = (typeof raw === 'string' ? raw : Children.toArray(raw).join('')).replace(/\n$/, '')
  const language = /language-([\w+#.-]+)/.exec(child.props.className ?? '')?.[1] ?? null
  return { text, language }
}

export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    if (!(await copyText(code))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  // A Mermaid diagram needs the mermaid package (pending the lead's decision): until then the source stays readable.
  const mermaid = language?.toLowerCase() === 'mermaid'
  const label = mermaid ? 'Mermaid diagram' : (language ?? 'text')
  const highlighted = !mermaid && normalizeLanguage(language) !== null
  return (
    <figure className="chat-code">
      <figcaption className="chat-code-head">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy ${label} code`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {copied && (
          <span className="chat-sr-only" role="status">
            Copied
          </span>
        )}
      </figcaption>
      <pre tabIndex={0}>
        <code>
          {highlighted
            ? tokenize(code, language).map((token, index) =>
                token.type === 'plain' ? (
                  token.text
                ) : (
                  <span key={index} className={`tok-${token.type}`}>
                    {token.text}
                  </span>
                ),
              )
            : code}
        </code>
      </pre>
    </figure>
  )
}

/** Where `workspace://` links point: the agent whose files they are (usually the author) and the agents Score knows. */
export type WorkspaceLinkContext = {
  agentId: string | null
  agentIds: readonly string[]
  /** The bold room can send a job's files to its Workbench; the classic screens keep the Workspace tab. */
  linkFor?: (target: WorkspaceTarget) => string
  /** The bold room refreshes a stale Results read before the link opens its Workbench. */
  prepare?: (target: WorkspaceTarget) => Promise<void>
}

const baseComponents: Components = {
  // Remote images would be fetched without the person asking: show the alt text instead.
  img: ({ alt }) => <span className="chat-md-image">{alt || 'image'}</span>,
  pre: ({ children }) => {
    const block = codeOf(children)
    return block ? <CodeBlock code={block.text} language={block.language} /> : <pre>{children}</pre>
  },
  table: ({ children }) => (
    <div className="chat-md-table" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  ),
}

function WorkspaceLink({
  to,
  resolve,
  target,
  prepare,
  children,
}: {
  to: string
  resolve: () => string
  target: WorkspaceTarget
  prepare?: (target: WorkspaceTarget) => Promise<void>
  children: ReactNode
}) {
  const navigate = useNavigate()
  return (
    <Link
      className="chat-workspace-link"
      to={to}
      onClick={(event) => {
        if (!prepare) return
        event.preventDefault()
        void prepare(target).finally(() => navigate(resolve()))
      }}
    >
      {children}
    </Link>
  )
}

/**
 * Chat text as Markdown (PLAN 5.25). react-markdown renders to React elements and drops raw HTML by default; there is no
 * rehype-raw here and there must never be one: a reply is untrusted text.
 */
export function Markdown({
  text,
  streaming = false,
  workspace,
}: {
  text: string
  streaming?: boolean
  workspace?: WorkspaceLinkContext
}) {
  const shown = useFrameText(text, streaming)
  const inRouter = useInRouterContext()
  const agentId = workspace?.agentId ?? null
  const agentIds = workspace?.agentIds
  const linkFor = workspace?.linkFor
  const prepare = workspace?.prepare
  const components = useMemo<Components>(
    () => ({
      ...baseComponents,
      a: ({ href, children }) => {
        if (isWorkspaceHref(href)) {
          const target = parseWorkspaceLink(href, agentId, agentIds ?? [])
          // No agent to open it in: keep the words, drop the link.
          if (!target || !inRouter)
            return target ? (
              <a href={target.to}>{children}</a>
            ) : (
              <span title="This link points into a workspace, but no agent is known for it">
                {children}
              </span>
            )
          return (
            <WorkspaceLink
              to={linkFor?.(target) ?? target.to}
              resolve={() => linkFor?.(target) ?? target.to}
              target={target}
              prepare={prepare}
            >
              {children}
            </WorkspaceLink>
          )
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      },
    }),
    [agentId, agentIds, inRouter, linkFor, prepare],
  )
  return (
    <div className="chat-text chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        // `workspace:` is ours (it only ever becomes an in-app link); every other scheme keeps the default filter.
        urlTransform={(url) => (isWorkspaceHref(url) ? url : defaultUrlTransform(url))}
      >
        {
          // While a reply streams, its last row is often half written: tables are found once it is complete.
          streaming ? normalizeBullets(shown) : normalizeTables(normalizeBullets(shown))
        }
      </ReactMarkdown>
    </div>
  )
}

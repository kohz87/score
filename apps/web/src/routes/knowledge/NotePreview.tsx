import type { KnowledgeLink, KnowledgeNoteSummary } from '@score/contract'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router'
import '../chat/chat.css'
import { CodeBlock } from '../chat/Markdown.tsx'
import { noteUrl } from './knowledge-paths.ts'
import { resolveTarget, WIKI_HREF, wikilinksToMarkdown } from './wikilinks.ts'

type Props = {
  body: string
  links: KnowledgeLink[]
  notes: KnowledgeNoteSummary[]
  onCreate: (target: string) => void
}

export function NotePreview({ body, links, notes, onCreate }: Props) {
  return (
    <div className="kn-preview chat-md" aria-label="Preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // The default transform drops unknown schemes; our wikilinks are `#wiki:` fragments.
        urlTransform={(url) => (url.startsWith(WIKI_HREF) ? url : defaultUrl(url))}
        components={{
          // Remote images would load without being asked for: the alt text stands in (as in Chat).
          img: ({ alt }) => <span className="chat-md-image">{alt || 'image'}</span>,
          pre: ({ children }) => {
            const block = codeOf(children)
            return block ? (
              <CodeBlock code={block.text} language={block.language} />
            ) : (
              <pre>{children}</pre>
            )
          },
          // Wide tables scroll inside a focusable region instead of widening the page.
          table: ({ children }) => (
            <div className="chat-md-table" tabIndex={0} role="region" aria-label="Table">
              <table>{children}</table>
            </div>
          ),
          blockquote: ({ children }) => calloutOf(children) ?? <blockquote>{children}</blockquote>,
          a({ href, children }) {
            if (href?.startsWith(WIKI_HREF)) {
              const target = decodeTarget(href.slice(WIKI_HREF.length))
              // Ordinary Markdown can use the internal prefix too; a broken payload is just text.
              if (target === null) return <span>{children}</span>
              const path = resolveTarget(target, links, notes)
              if (path)
                return (
                  <Link className="kn-wikilink" to={noteUrl(path)}>
                    {children}
                  </Link>
                )
              return (
                <span className="kn-wikilink is-missing">
                  <span title="This note does not exist yet">{children}</span>
                  <span className="kn-missing-tag"> (missing) </span>
                  <button type="button" onClick={() => onCreate(target)}>
                    Create<span className="kn-sr"> {target}</span>
                  </button>
                </span>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          },
        }}
      >
        {wikilinksToMarkdown(body)}
      </Markdown>
    </div>
  )
}

function defaultUrl(url: string): string {
  return /^(https?:|mailto:|#|\/|\.)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) ? url : ''
}

function decodeTarget(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function codeOf(children: ReactNode): { text: string; language: string | null } | null {
  const child = Children.toArray(children)[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const raw = child.props.children
  const text = (typeof raw === 'string' ? raw : Children.toArray(raw).join('')).replace(/\n$/, '')
  const language = /language-([\w+#.-]+)/.exec(child.props.className ?? '')?.[1] ?? null
  return { text, language }
}

const CALLOUT = /^\[!([A-Za-z]+)\][+-]?[ \t]*/
const KINDS: Record<string, string> = {
  note: 'note',
  info: 'note',
  abstract: 'note',
  summary: 'note',
  todo: 'note',
  tip: 'tip',
  hint: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  warning: 'warn',
  caution: 'warn',
  attention: 'warn',
  question: 'warn',
  danger: 'danger',
  error: 'danger',
  bug: 'danger',
  failure: 'danger',
  fail: 'danger',
}

/** `> [!note] Title` becomes a callout box; any other quote is left to the default renderer (null). */
function calloutOf(children: ReactNode): ReactElement | null {
  const items = Children.toArray(children)
  const index = items.findIndex((item) => isValidElement(item))
  const first = items[index]
  if (!isValidElement<{ children?: ReactNode }>(first) || first.type !== 'p') return null
  const content = Children.toArray(first.props.children)
  const head = content[0]
  const found = typeof head === 'string' ? CALLOUT.exec(head) : null
  if (!found || typeof head !== 'string') return null
  const rest = head.slice(found[0].length)
  const newline = rest.indexOf('\n')
  const title = newline === -1 ? rest : rest.slice(0, newline)
  const body = newline === -1 ? '' : rest.slice(newline + 1)
  const name = found[1]!.toLowerCase()
  const kind = KINDS[name] ?? 'note'
  const paragraph = [body, ...content.slice(1)]
  const hasBody = paragraph.some((part) => part !== '')
  items[index] = hasBody ? cloneElement(first, undefined, ...paragraph) : <></>
  return (
    <div className={`kn-callout kn-callout-${kind}`} role="note">
      <p className="kn-callout-title">
        {title.trim() || name.charAt(0).toUpperCase() + name.slice(1)}
      </p>
      {items}
    </div>
  )
}

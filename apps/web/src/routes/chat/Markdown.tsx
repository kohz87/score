import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyText } from '../../data/clipboard.ts'
import { normalizeLanguage, tokenize } from './highlight.ts'

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

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
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

/**
 * Chat text as Markdown (PLAN 5.25). react-markdown renders to React elements and drops raw HTML by default; there is no
 * rehype-raw here and there must never be one: a reply is untrusted text.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const shown = useFrameText(text, streaming)
  return (
    <div className="chat-text chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {shown}
      </ReactMarkdown>
    </div>
  )
}

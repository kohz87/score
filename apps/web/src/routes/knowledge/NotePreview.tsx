import type { KnowledgeLink, KnowledgeNoteSummary } from '@score/contract'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router'
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
    <div className="kn-preview" aria-label="Preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // The default transform drops unknown schemes; our wikilinks are `#wiki:` fragments.
        urlTransform={(url) => (url.startsWith(WIKI_HREF) ? url : defaultUrl(url))}
        components={{
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

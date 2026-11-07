import { TYPE_LABEL } from '../routes/knowledge/knowledge-files.ts'
import { baseName } from '../routes/knowledge/knowledge-paths.ts'
import type { useSearch } from '../routes/knowledge/knowledge-queries.ts'
import { splitSnippet } from '../routes/knowledge/wikilinks.ts'

export function SearchResults({
  search,
  debounced,
  onOpen,
}: {
  search: ReturnType<typeof useSearch>
  debounced: string
  onOpen: (path: string) => void
}) {
  return (
    <section className="bold-library-results" aria-label="Search results">
      {search.isPending && debounced !== '' && <p role="status">Searching…</p>}
      {search.isError && <p role="alert">Couldn’t search the Library. Try again.</p>}
      {search.data && search.data.length === 0 && (
        <p className="muted small">Nothing matches “{debounced}”.</p>
      )}
      <ul>
        {(search.data ?? []).map((hit) => (
          <li key={hit.path}>
            <button type="button" onClick={() => onOpen(hit.path)}>
              <strong>
                {hit.title || baseName(hit.path)}
                {hit.kind === 'document' && hit.type && (
                  <span className="kn-type-badge">{TYPE_LABEL[hit.type]}</span>
                )}
              </strong>
              <span className="kn-path">{hit.path}</span>
              <span className="bold-library-snippet">
                {splitSnippet(hit.snippet).map((part, index) =>
                  part.match ? <mark key={index}>{part.text}</mark> : part.text,
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

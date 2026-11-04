import { useEffect, useRef, useState } from 'react'
import type { AgentSummary } from '@score/contract'
import { Link, useLocation, useSearchParams } from 'react-router'
import { agentDisplayName } from '../bold-agents.ts'
import { ScreenIcon } from '../BoldIcons.tsx'
import { useJobResults } from '../bold-results-queries.ts'
import { activityLabel } from './chat-model.ts'
import { FILE_ROWS_SHOWN, fileRows, viewerLink, type FileRow } from './files-model.ts'

/** The row the viewer sheet was opened from; closing the sheet returns focus to it. */
let lastOpenedRow: string | null = null
export function focusOpenedRow(root: ParentNode = document): boolean {
  if (lastOpenedRow === null) return false
  const rows = root.querySelectorAll<HTMLElement>('[data-files-row]')
  for (const row of rows) {
    if (row.dataset.filesRow === lastOpenedRow) {
      row.focus()
      return true
    }
  }
  return false
}

function RowIcon({ kind }: { kind: FileRow['kind'] }) {
  if (kind === 'screen') return <ScreenIcon size={16} />
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {kind === 'link' ? (
        <path
          d="M6.5 9.5l3-3M5.5 7.5l-1 1a2.1 2.1 0 003 3l1-1M10.5 8.5l1-1a2.1 2.1 0 00-3-3l-1 1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : (
        <path
          d={
            kind === 'draft'
              ? 'M3 13l.6-2.6L10.5 3.5l2 2-6.9 6.9L3 13z'
              : 'M4 2.5h5l3 3v8H4v-11zM9 2.5v3h3'
          }
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

/**
 * Info's "Files and results" section (3.25.0, DECISIONS 161): what the current topic (or direct chat) made. A row opens
 * the viewer sheet over the conversation, on that item.
 */
export function FilesAndResults({
  jobId,
  agents,
}: {
  jobId: string | null
  agents: AgentSummary[]
}) {
  const location = useLocation()
  const [params] = useSearchParams()
  const { results, pending, failed, retry } = useJobResults(jobId)
  const [all, setAll] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const names = new Map(agents.map((agent) => [agent.id, agentDisplayName(agent)]))
  const nameOf = (id: string) => names.get(id) ?? id
  const rows = fileRows(results, (id) => `${nameOf(id)}’s screen`)
  const shown = all ? rows : rows.slice(0, FILE_ROWS_SHOWN)

  // `?work=results` lands here: Info at Files and results.
  const landed = params.get('work') === 'results'
  useEffect(() => {
    if (landed) headingRef.current?.scrollIntoView?.({ block: 'start' })
  }, [landed])

  return (
    <section aria-labelledby="chat-info-files" data-testid="files-results">
      <h2 id="chat-info-files" ref={headingRef} className="bold-chat-kicker" tabIndex={-1}>
        Files and results
      </h2>
      {jobId === null || (rows.length === 0 && !pending && !failed) ? (
        <p className="bold-chat-note">Nothing made in this topic yet</p>
      ) : rows.length === 0 && failed ? (
        <p className="bold-chat-note" role="alert">
          Couldn’t load the files and results.{' '}
          <button type="button" className="btn sm" onClick={retry}>
            Retry
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="bold-chat-note" role="status">
          Looking at what was made…
        </p>
      ) : (
        <>
          <ul className="bold-files-list">
            {shown.map((row) => {
              const who = row.by.map(nameOf).join(', ')
              return (
                <li key={row.key}>
                  <Link
                    to={viewerLink(location.search, jobId, row.tab, row.file)}
                    className="bold-files-row"
                    data-files-row={row.key}
                    data-kind={row.kind}
                    title={row.title}
                    onClick={() => {
                      lastOpenedRow = row.key
                    }}
                  >
                    <span className="bold-files-icon">
                      <RowIcon kind={row.kind} />
                    </span>
                    <span className="bold-files-name">{row.name}</span>
                    <span className="bold-files-meta">
                      {who}
                      {who && row.at ? ' · ' : ''}
                      {activityLabel(row.at)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
          {rows.length > FILE_ROWS_SHOWN && (
            <button
              type="button"
              className="btn sm"
              aria-expanded={all}
              onClick={() => setAll((open) => !open)}
            >
              {all ? 'Show fewer' : `Show all (${rows.length})`}
            </button>
          )}
        </>
      )}
      {failed && rows.length > 0 && (
        <p className="bold-chat-note" role="alert">
          Some files couldn’t be refreshed.
        </p>
      )}
    </section>
  )
}

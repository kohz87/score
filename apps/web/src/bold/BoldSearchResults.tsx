import type { AgentSummary } from '@score/contract'
import type { ReactNode } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { jobDot } from './room/job-dot.ts'
import { BookIcon } from './BoldIcons.tsx'
import type { BoldSearchGroup, BoldSearchResult } from './bold-search-model.ts'

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().replace(/^[/@]/, '').toLowerCase()
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

/** Renders the FTS snippet's `[[matched]]` words without exposing the brackets. */
function MarkedSnippet({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const pattern = /\[\[(.*?)\]\]/gs
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(<mark key={match.index}>{match[1]}</mark>)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length ? <>{parts}</> : text.replaceAll('[[', '').replaceAll(']]', '')
}

export function BoldSearchResults({
  groups,
  active,
  entries,
  listId,
  query,
  agents,
  onHover,
  onPick,
}: {
  groups: readonly BoldSearchGroup[]
  active: number
  entries: readonly BoldSearchResult[]
  listId: string
  query: string
  agents: ReadonlyMap<string, AgentSummary>
  onHover: (index: number) => void
  onPick: (result: BoldSearchResult) => void
}) {
  return (
    <div id={listId} className="bold-search-list" role="listbox" aria-label="Results">
      {groups.length === 0 && <p className="bold-search-empty">Nothing matches.</p>}
      {groups.map((group) => (
        <ResultGroup
          key={group.key}
          group={group}
          active={active}
          entries={entries}
          listId={listId}
          query={query}
          agents={agents}
          onHover={onHover}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

function ResultGroup({
  group,
  active,
  entries,
  listId,
  query,
  agents,
  onHover,
  onPick,
}: {
  group: BoldSearchGroup
  active: number
  entries: readonly BoldSearchResult[]
  listId: string
  query: string
  agents: ReadonlyMap<string, AgentSummary>
  onHover: (index: number) => void
  onPick: (result: BoldSearchResult) => void
}) {
  const headingId = `${listId}-${group.key}`
  return (
    <div role="group" aria-labelledby={headingId}>
      <div className="bold-search-section" id={headingId}>
        {group.label}
      </div>
      {group.items.map((result) => {
        const index = entries.indexOf(result)
        const agentId =
          result.kind === 'chat'
            ? result.agentId
            : result.kind === 'routine'
              ? result.agentId
              : result.kind === 'message'
                ? result.agentId
                : result.kind === 'job'
                  ? result.agentId
                  : null
        const agent = agentId ? agents.get(agentId) : undefined
        const icon =
          result.kind === 'note' ? (
            <BookIcon size={22} />
          ) : agent ? (
            <AgentGlyph agent={agent} size="sm" bare decorative />
          ) : result.kind === 'job' ? (
            // The state dot the room's job tabs use, so a job with no agent yet is never an empty box.
            <span className="bold-search-job-dot" style={{ background: jobDot(result.state) }} />
          ) : null
        return (
          <button
            key={result.id}
            id={`${listId}-option-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            className={`bold-search-result${index === active ? ' active' : ''}`}
            data-protected="any"
            disabled={result.disabled}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(result)}
          >
            {icon && (
              <span className="bold-search-glyph" aria-hidden="true">
                {icon}
              </span>
            )}
            <span className="bold-search-copy">
              <span className="bold-search-title">
                {result.titleMarkup ? (
                  <MarkedSnippet text={result.titleMarkup} />
                ) : (
                  <Highlight text={result.title} query={query} />
                )}
              </span>
              {result.hint && (
                <span className="bold-search-hint">
                  {result.hintMarkup ? (
                    <MarkedSnippet text={result.hintMarkup} />
                  ) : (
                    <Highlight text={result.hint} query={query} />
                  )}
                </span>
              )}
            </span>
            {result.kind === 'job' && result.unread > 0 && (
              <span className="bold-search-unread" aria-label={`${result.unread} unread`}>
                {result.unread} unread
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

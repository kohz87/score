import type { AgentSummary, OutsideSession } from '@score/contract'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useImportSession, useOutsideSessions } from '../../data/outside-sessions.ts'

function when(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** "From elsewhere" (PLAN 5.26): the agents' Hermes sessions that Score did not start, grouped by where they happened. */
export function OutsideSessions({ agents }: { agents: AgentSummary[] }) {
  const [open, setOpen] = useState(false)
  // Read from the agents' databases only once the section is opened.
  const sessions = useOutsideSessions(open)
  const importSession = useImportSession()
  const navigate = useNavigate()
  const items = sessions.data?.items ?? []
  const groups = Map.groupBy(items, (item) => item.sourceLabel)
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  function row(item: OutsideSession) {
    return (
      <li key={`${item.agentId}:${item.id}`} className="chat-outside-row">
        <span className="chat-outside-title">{item.title || 'Untitled session'}</span>
        <span className="chat-outside-meta">
          {nameOf(item.agentId)} · {when(item.startedAt)} · {item.messageCount}{' '}
          {item.messageCount === 1 ? 'message' : 'messages'}
          {item.busy ? ' · active now' : ''}
        </span>
        {item.roomId ? (
          <Link
            className="chat-small-button"
            to={`/chat/${encodeURIComponent(item.roomId)}`}
            aria-label={`Open the imported room for ${item.title || 'this session'}`}
          >
            Open room
          </Link>
        ) : (
          <button
            type="button"
            className="chat-small-button"
            disabled={importSession.isPending}
            aria-label={`Import ${item.title || 'this session'} from ${item.sourceLabel}`}
            onClick={() =>
              importSession.mutate(
                { agentId: item.agentId, sessionId: item.id },
                { onSuccess: ({ roomId }) => void navigate(`/chat/${encodeURIComponent(roomId)}`) },
              )
            }
          >
            Import
          </button>
        )}
      </li>
    )
  }
  return (
    <div className="chat-room-group chat-outside">
      <div className="chat-group-head">
        <h2>From elsewhere</h2>
        <button
          type="button"
          className="chat-small-button"
          aria-expanded={open}
          aria-controls="chat-outside-list"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div id="chat-outside-list">
          <p className="chat-list-empty">
            Conversations your agents had on Telegram, the command line and other places. Importing
            copies them here to read; nothing changes in Hermes.
          </p>
          {sessions.isLoading && <p role="status">Looking for sessions…</p>}
          {sessions.isError && <p role="alert">Couldn’t read the agents’ sessions.</p>}
          {sessions.data && items.length === 0 && (
            <p className="chat-list-empty">No sessions from elsewhere.</p>
          )}
          {[...groups].map(([label, group]) => (
            <section key={label} aria-label={label} className="chat-subgroup">
              <h3>{label}</h3>
              <ul className="chat-outside-list">{group.map(row)}</ul>
            </section>
          ))}
          {(sessions.data?.unavailable.length ?? 0) > 0 && (
            <p className="chat-list-empty">
              Couldn’t read the sessions of {sessions.data!.unavailable.map(nameOf).join(', ')}.
            </p>
          )}
          {importSession.isError && <p role="alert">Couldn’t import that session.</p>}
          <button
            type="button"
            className="chat-small-button"
            onClick={() => void sessions.refetch()}
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  )
}

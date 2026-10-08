import type { AgentSummary } from '@score/contract'
import { useContext, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { QueryError } from './ChatThread.tsx'
import { roomPanelsQuery, roomQuery } from './queries.ts'

function possessives(names: string[]) {
  const owned = names.map((name) => `${name}’s`)
  if (owned.length < 2) return owned.join('')
  return `${owned.slice(0, -1).join(', ')} and ${owned.at(-1)}`
}

export function RoomPanels({ roomId, agents }: { roomId: string; agents: AgentSummary[] }) {
  const panelsDefinition = useMemo(() => roomPanelsQuery(roomId), [roomId])
  const panels = useStreamQuery(panelsDefinition)
  const { data: room } = useStreamQuery(useMemo(() => roomQuery(roomId), [roomId]))
  const context = useContext(StreamContext)!
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // A finished reply may have touched files and /remember saves a fact: re-read the computed lists.
  useEffect(
    () =>
      context.client.subscribe((event) => {
        const relevant =
          (event.type === 'message.completed' && event.data.roomId === roomId) ||
          (event.type === 'memory.saved' &&
            event.data.source?.kind === 'room' &&
            event.data.source.roomId === roomId)
        if (relevant) void context.queries.register(panelsDefinition).refetch()
      }),
    [context, roomId, panelsDefinition],
  )
  const name = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const data = panels.data
  return (
    <div className="chat-side-column" data-open={open}>
      <button
        className="chat-side-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide room details' : 'Show room details'}
      </button>
      <aside id={bodyId} className="chat-side-panels" aria-label="About this room">
        {panels.status === 'error' && !data && (
          <QueryError
            text="Could not load room details."
            retry={() => void context.queries.register(panelsDefinition).refetch()}
          />
        )}
        {panels.status === 'pending' && !data && <p role="status">Loading room details…</p>}
        <section className="chat-side-card" aria-labelledby={`${bodyId}-files`}>
          <h2 id={`${bodyId}-files`}>Files in play</h2>
          {data &&
            (data.filesInPlay.length ? (
              <ul className="chat-files">
                {data.filesInPlay.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            ) : (
              <p className="chat-side-empty">No files touched yet.</p>
            ))}
        </section>
        <section className="chat-side-card" aria-labelledby={`${bodyId}-learned`}>
          <h2 id={`${bodyId}-learned`}>Learned here</h2>
          {data &&
            (data.learned.length ? (
              data.learned.map((item) => (
                <div className="chat-learned" key={`${item.at}:${item.text}`}>
                  <p>{item.text}</p>
                  <span>Saved to {possessives(item.savedTo.map(name))} memory</span>
                  {item.savedTo[0] && (
                    <Link
                      to={`/team/${encodeURIComponent(item.savedTo[0])}`}
                      aria-label={`Open memory of ${name(item.savedTo[0])}`}
                    >
                      Open memory
                    </Link>
                  )}
                </div>
              ))
            ) : (
              <p className="chat-side-empty">Nothing saved from this room yet.</p>
            ))}
        </section>
        <section className="chat-side-card" aria-labelledby={`${bodyId}-channels`}>
          <h2 id={`${bodyId}-channels`}>Also reachable on</h2>
          {room &&
            (room.channels.length ? (
              <ul className="chat-channels">
                {room.channels.map((channel) => (
                  <li key={`${channel.platform}:${channel.label}`}>{channel.label}</li>
                ))}
              </ul>
            ) : (
              <p className="chat-side-empty">Not mirrored to any channel.</p>
            ))}
          <Link to="/settings">Manage channels</Link>
        </section>
      </aside>
    </div>
  )
}

import type { AgentSummary, Room } from '@score/contract'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { SearchSnippet } from '../../components/SearchSnippet.tsx'
import { messageHref, useMessageSearch } from '../../data/message-search.ts'
import { roomLabel } from './room-label.ts'

/** Searches the text of every message (PLAN 5.26); a hit opens its room scrolled to that message. */
export function ConversationSearch({ rooms, agents }: { rooms: Room[]; agents: AgentSummary[] }) {
  const [text, setText] = useState('')
  const id = useId()
  const search = useMessageSearch(text)
  const where = (roomId: string, fallback: string) => {
    const room = rooms.find((item) => item.id === roomId)
    if (!room) return fallback
    if (room.kind === 'direct')
      return agents.find((agent) => agent.id === room.leadAgentId)?.name ?? room.name
    return roomLabel(room)
  }
  const active = text.trim().length >= 2
  return (
    <div className="chat-search" role="search">
      <label className="chat-sr-only" htmlFor={id}>
        Search messages
      </label>
      <input
        id={id}
        type="search"
        placeholder="Search messages"
        value={text}
        maxLength={200}
        onChange={(event) => setText(event.target.value)}
      />
      {active && (
        <div className="chat-search-results" aria-live="polite">
          {search.isError && <p role="alert">Search isn’t available right now.</p>}
          {search.data?.length === 0 && <p className="chat-list-empty">No messages found.</p>}
          <ul aria-label="Search results">
            {search.data?.map((hit) => (
              <li key={hit.messageId}>
                <Link to={messageHref(hit.roomId, hit.messageId)} onClick={() => setText('')}>
                  <span className="chat-hit-where">
                    {where(hit.roomId, hit.roomName)} ·{' '}
                    <time dateTime={hit.createdAt}>
                      {new Date(hit.createdAt).toLocaleDateString()}
                    </time>
                  </span>
                  <span className="chat-hit-snippet">
                    <SearchSnippet text={hit.snippet} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

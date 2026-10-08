import type { AgentSummary, Room } from '@score/contract'
import { useContext } from 'react'
import { Link, useParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { ChatThread, QueryError } from './ChatThread.tsx'
import { RoomPanels } from './RoomPanels.tsx'
import { agentsQuery, roomsQuery } from './queries.ts'
import { roomLabel } from './room-label.ts'
import { agentTextColor } from './agent-text-color.ts'
import './chat.css'

function RoomLink({
  room,
  selected,
  agents,
}: {
  room: Room
  selected?: string
  agents: AgentSummary[]
}) {
  const agent = agents.find((item) => item.id === room.leadAgentId)
  return (
    <Link
      className={`chat-room-link${room.kind === 'direct' ? ' chat-room-link--direct' : ''}`}
      to={`/chat/${encodeURIComponent(room.id)}`}
      aria-current={room.id === selected ? 'page' : undefined}
    >
      {room.kind === 'direct' && agent && <AgentGlyph agent={agent} size="sm" decorative />}
      <span className="chat-room-name">
        <span>{room.kind === 'direct' ? (agent?.name ?? room.name) : roomLabel(room)}</span>
        {room.kind === 'direct' && agent && (
          <small
            style={
              agent.status === 'working' ? { color: agentTextColor(agent.style.color) } : undefined
            }
          >
            {agent.status === 'up-next'
              ? 'Up next'
              : agent.status[0]!.toUpperCase() + agent.status.slice(1)}
          </small>
        )}
      </span>
      {room.unread > 0 && (
        <span className="chat-unread" aria-label={`${room.unread} unread messages`}>
          {room.unread}
        </span>
      )}
      {room.kind === 'room' && (
        <span className="chat-active-agents">
          {room.activeAgents.map((id) => {
            const active = agents.find((item) => item.id === id)
            return active ? (
              <AgentGlyph key={id} agent={active} size="xs" bare describeShape />
            ) : (
              <span key={id}>{id}</span>
            )
          })}
        </span>
      )}
    </Link>
  )
}

export function ChatPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const rooms = useStreamQuery(roomsQuery)
  const agents = useStreamQuery(agentsQuery)
  const context = useContext(StreamContext)!
  return (
    <div className="chat-layout">
      <aside className="chat-conversations" aria-label="Conversations">
        <button className="chat-new" type="button" disabled>
          ＋ New chat
        </button>
        {rooms.status === 'pending' && !rooms.data && <p role="status">Loading conversations…</p>}
        {rooms.status === 'error' && (
          <QueryError
            text="Could not load conversations."
            retry={() => void context.queries.register(roomsQuery).refetch()}
          />
        )}
        {agents.status === 'error' && (
          <QueryError
            text="Could not load agents."
            retry={() => void context.queries.register(agentsQuery).refetch()}
          />
        )}
        <nav aria-label="Conversations">
          <div className="chat-room-group">
            <h2>Rooms</h2>
            {rooms.data?.rooms.map((room) => (
              <RoomLink key={room.id} room={room} selected={roomId} agents={agents.data ?? []} />
            ))}
            {rooms.data && !rooms.data.rooms.length && (
              <p className="chat-list-empty">No rooms yet.</p>
            )}
          </div>
          <div className="chat-room-group">
            <h2>Direct</h2>
            {rooms.data?.directs.map((room) => (
              <RoomLink key={room.id} room={room} selected={roomId} agents={agents.data ?? []} />
            ))}
            {rooms.data && !rooms.data.directs.length && (
              <p className="chat-list-empty">No direct conversations yet.</p>
            )}
          </div>
        </nav>
      </aside>
      {roomId ? (
        <ChatThread key={roomId} roomId={roomId} agents={agents.data ?? []} />
      ) : (
        <section className="chat-thread chat-welcome" aria-label="Conversation">
          <h1>Chat</h1>
          <p>Choose a conversation to see its messages.</p>
        </section>
      )}
      {roomId && <RoomPanels key={roomId} roomId={roomId} agents={agents.data ?? []} />}
    </div>
  )
}

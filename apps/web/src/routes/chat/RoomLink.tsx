import type { AgentSummary, Room } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentTextColor } from './agent-text-color.ts'
import { roomLabel } from './room-label.ts'

export function RoomLink({
  room,
  selected,
  agents,
  orchestration = false,
}: {
  room: Room
  selected?: string | undefined
  agents: AgentSummary[]
  orchestration?: boolean
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
        <span>
          {room.pinned && (
            <span className="chat-pin" role="img" aria-label="Pinned">
              ★{' '}
            </span>
          )}
          {room.kind === 'direct' ? (agent?.name ?? room.name) : roomLabel(room)}
        </span>
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
        {room.importedFrom && <small>From {room.importedFrom.label}</small>}
        {orchestration && <small>Orchestration</small>}
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

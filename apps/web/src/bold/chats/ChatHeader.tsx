import type { AgentSummary, Room } from '@score/contract'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { useSharedWorkspaces } from '../workspaces-queries.ts'

/** What the header says about who owns a chat: its lead, else "no owner yet". */
export function ownerLabel(room: Room, agents: AgentSummary[]): string {
  if (!room.leadAgentId) return 'no owner yet'
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  return lead ? agentDisplayName(lead) : room.leadAgentId
}

/**
 * The group chat's header row (3.21.0): owner, member count, workspace and the Chat info button. The chat's name is the
 * room switcher right above it, so the name is not drawn twice.
 */
export function ChatHeader({
  room,
  agents,
  infoOpen,
  onToggleInfo,
}: {
  room: Room
  agents: AgentSummary[]
  infoOpen: boolean
  onToggleInfo: () => void
}) {
  const workspaces = useSharedWorkspaces(Boolean(room.workspaceId)).data
  const workspace = room.workspaceId
    ? workspaces?.find((item) => item.id === room.workspaceId)
    : undefined
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  return (
    <div className="bold-chat-header" role="group" aria-label={`${room.name}, chat header`}>
      <span className="bold-chat-meta">
        Owner{' '}
        <b style={lead ? { color: agentNameColor(lead) } : undefined}>{ownerLabel(room, agents)}</b>{' '}
        · {room.members.length} {room.members.length === 1 ? 'member' : 'members'}
        {workspace && (
          <>
            {' '}
            · workspace <code>{workspace.name}</code>
          </>
        )}
      </span>
      <button type="button" className="btn sm" aria-pressed={infoOpen} onClick={onToggleInfo}>
        Chat info
      </button>
    </div>
  )
}

/** The phone's chat bar (board 18, phone): a round Back, the name with its owner line, and a round Info button. */
export function ChatPhoneBar({
  room,
  agents,
  onBack,
  onInfo,
}: {
  room: Room
  agents: AgentSummary[]
  onBack: () => void
  onInfo: () => void
}) {
  return (
    <div className="bold-chat-phone-bar">
      <button
        type="button"
        className="bold-chat-round small"
        aria-label="Back to chats"
        onClick={onBack}
      >
        ‹
      </button>
      <div className="bold-chat-phone-id">
        <strong>{room.name}</strong>
        <span>
          Owner {ownerLabel(room, agents)} · {room.members.length}{' '}
          {room.members.length === 1 ? 'member' : 'members'}
        </span>
      </div>
      <button
        type="button"
        className="bold-chat-round small"
        aria-label="Chat info"
        onClick={onInfo}
      >
        i
      </button>
    </div>
  )
}

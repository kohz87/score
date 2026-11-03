import type { AgentSummary, Job, Room } from '@score/contract'
import type { ReactNode, RefObject } from 'react'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { jobStateLabel } from '../room/room-model.ts'
import { useSharedWorkspaces } from '../workspaces-queries.ts'

/** What the header says about who owns a chat: its lead, else "no owner yet". */
export function ownerLabel(room: Room, agents: AgentSummary[]): string {
  if (!room.leadAgentId) return 'no owner yet'
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  return lead ? agentDisplayName(lead) : room.leadAgentId
}

function membersLabel(room: Room): string {
  return `${room.members.length} ${room.members.length === 1 ? 'member' : 'members'}`
}

/** The line under the chat's name (board 18): "Owner lead · 4 members · workspace activity-feed". */
export function ChatMeta({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const workspaces = useSharedWorkspaces(Boolean(room.workspaceId)).data
  const workspace = room.workspaceId
    ? workspaces?.find((item) => item.id === room.workspaceId)
    : undefined
  const lead = agents.find((agent) => agent.id === room.leadAgentId)
  return (
    <span className="bold-chat-meta" aria-label={`${room.name}, chat header`} role="group">
      Owner{' '}
      <b style={lead ? { color: agentNameColor(lead) } : undefined}>{ownerLabel(room, agents)}</b>
      {' · '}
      {membersLabel(room)}
      {workspace && (
        <>
          {' · workspace '}
          <code>{workspace.name}</code>
        </>
      )}
    </span>
  )
}

/** The pill at the right end of the chat bar; it opens and closes the side panel's Info. */
export function ChatInfoButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="bold-chat-infobtn" aria-pressed={open} onClick={onToggle}>
      Chat info
    </button>
  )
}

/**
 * The phone's chat bar (board 18, phone): a round Back to the list, the name with its owner line (and the open topic),
 * the chat's ⋯ menu and a round Info button that opens the side sheet.
 */
export function ChatPhoneBar({
  room,
  agents,
  job,
  infoRef,
  infoExpanded,
  onBack,
  onInfo,
  menu,
  badge,
}: {
  room: Room
  agents: AgentSummary[]
  /** A named job that is open (not the chat's default conversation). */
  job?: Job
  infoRef?: RefObject<HTMLButtonElement | null>
  infoExpanded?: boolean
  onBack: () => void
  onInfo: () => void
  menu?: ReactNode
  /** The archived badge with its Unarchive: the state and the way back stay on the phone too. */
  badge?: ReactNode
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
        <strong data-phone-chat-title tabIndex={-1}>
          {room.name}
        </strong>
        <span>
          {job
            ? `${job.title} · ${jobStateLabel(job).toLowerCase()}`
            : `Owner ${ownerLabel(room, agents)} · ${membersLabel(room)}`}
        </span>
        {badge}
      </div>
      {menu}
      <button
        ref={infoRef}
        type="button"
        className="bold-chat-round small"
        aria-label="Chat info"
        aria-expanded={infoExpanded ?? false}
        aria-controls="bold-side-panel"
        onClick={onInfo}
      >
        i
      </button>
    </div>
  )
}

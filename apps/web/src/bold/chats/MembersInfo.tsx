import type { AgentSummary, Room } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName, agentMood } from '../bold-agents.ts'
import { MemberEffortTag } from '../efforts/MemberEffortTag.tsx'
import { chatEffortOf, useRoomEfforts } from '../efforts/effort-queries.ts'
import { chatModelOf, useRoomModels } from '../models/model-queries.ts'
import { InfoSection } from './InfoSection.tsx'

/**
 * Chat info › Members. When an agent here runs another model or effort than its own, the section starts open and its folded
 * header says how many (the tags are the only sign of it; a person must not miss them). Otherwise it folds as before.
 */
export function MembersInfo({ room, agents }: { room: Room; agents: AgentSummary[] }) {
  const items = useRoomEfforts(room.id).items
  const models = useRoomModels(room.id).items
  const differing = room.members.filter(
    (id) =>
      agents.some((agent) => agent.id === id) &&
      (chatEffortOf(items, id) !== null || chatModelOf(models, id) !== null),
  ).length
  return (
    <InfoSection
      kind="members"
      headingId="chat-info-members"
      title="Members"
      summary={
        differing > 0
          ? `${room.members.length} · ${differing} set differently here`
          : String(room.members.length)
      }
      opensWhen={differing > 0}
    >
      <ul className="bold-chat-members">
        {room.members.map((id) => {
          const agent = agents.find((item) => item.id === id)
          return (
            <li key={id}>
              {agent && (
                <AgentGlyph agent={agent} size="sm" bare decorative mood={agentMood(agent)} />
              )}
              <span>{agent ? agentDisplayName(agent) : id}</span>
              {room.leadAgentId === id && <span className="bold-chat-role">owner</span>}
              {agent && <MemberEffortTag roomId={room.id} agent={agent} />}
            </li>
          )
        })}
      </ul>
      {!room.leadAgentId && <p className="bold-chat-note">No owner yet.</p>}
      <p className="bold-chat-note">
        A tag reads model · effort, for an agent this chat runs differently; the part that is its
        own says “its own”. No tag: its own model and effort. Click a tag to change or clear either.
      </p>
    </InfoSection>
  )
}

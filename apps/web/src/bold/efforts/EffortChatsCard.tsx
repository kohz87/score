import { Link } from 'react-router'
import { boldOneToOneLink } from '../bold-links.ts'
import { EFFORT_HINTS, isAmberEffort, ownEffortLabel } from './effort-model.ts'
import { useAgentEfforts } from './effort-queries.ts'
import './efforts.css'

/**
 * Agent settings › Model: the chats this agent's effort is set differently in, each with its level and a link to it
 * (mock-up 25-effort-agent-settings). Nothing shows when there are none.
 */
export function EffortChatsCard({ agentId }: { agentId: string }) {
  const efforts = useAgentEfforts(agentId).data
  if (!efforts || efforts.chats.length === 0) return null
  const count = efforts.chats.length
  return (
    <section className="bold-effort-chats" aria-label="Chats that override effort">
      <div className="bold-effort-chats-title">
        Set differently in {count} {count === 1 ? 'chat' : 'chats'}
      </div>
      <ul>
        {efforts.chats.map((chat) => (
          <li key={chat.roomId}>
            <span>
              <Link
                to={
                  chat.roomKind === 'direct'
                    ? boldOneToOneLink(agentId)
                    : `/b?room=${encodeURIComponent(chat.roomId)}`
                }
              >
                {chat.roomName}
              </Link>
              {chat.jobTitle && <span className="bold-effort-chats-job"> · {chat.jobTitle}</span>}
            </span>
            <span
              className={`bold-effort-level${isAmberEffort(chat.effort) ? ' bold-effort--max' : ''}`}
              title={EFFORT_HINTS[chat.effort]}
            >
              {chat.effort}
            </span>
          </li>
        ))}
      </ul>
      <p className="bold-effort-chats-note">
        Those chats keep their setting until it’s changed there. Every other chat uses{' '}
        {ownEffortLabel(efforts.own)}.
      </p>
    </section>
  )
}

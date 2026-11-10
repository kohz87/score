import { Link } from 'react-router'
import { boldOneToOneLink } from '../bold-links.ts'
import { useAgentChatModels } from './model-queries.ts'
import '../efforts/efforts.css'
import './models.css'

/**
 * Agent settings › Model: the chats this agent runs another model in, each with its model's label and a link to it (mock-up
 * 27-model-agentsettings). Nothing shows when there are none.
 */
export function ModelChatsCard({ agentId, own }: { agentId: string; own: string | undefined }) {
  const chats = useAgentChatModels(agentId).data?.chats ?? []
  if (chats.length === 0) return null
  return (
    <section className="bold-effort-chats" aria-label="Chats that override model">
      <div className="bold-effort-chats-title">
        Set differently in {chats.length} {chats.length === 1 ? 'chat' : 'chats'}
      </div>
      <ul>
        {chats.map((chat) => (
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
            <span className="bold-effort-level bold-effort--max" title={chat.model}>
              {chat.label}
            </span>
          </li>
        ))}
      </ul>
      <p className="bold-effort-chats-note">
        Those chats keep their model until it’s changed there. Every other chat uses{' '}
        {own ?? 'its own model'}.
      </p>
    </section>
  )
}

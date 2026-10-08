import type { AgentSummary, Message, MessagePart } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentTextColor } from './agent-text-color.ts'
import { ApprovalCard } from './ApprovalCard.tsx'
import { PlanCard } from './PlanCard.tsx'

function Part({ part, agents }: { part: MessagePart; agents: AgentSummary[] }) {
  switch (part.kind) {
    case 'text':
      return <p className="chat-text">{part.text}</p>
    case 'tools':
      return <div className="chat-compact chat-tools">{part.summary}</div>
    case 'file':
      return (
        <div className="chat-compact chat-file">
          <code>{part.path}</code>
          <span className="chat-added">+{part.added}</span>
          <span className="chat-removed">−{part.removed}</span>
        </div>
      )
    case 'image':
      return (
        <img
          className="chat-image"
          src={`/api/media/${encodeURIComponent(part.mediaId)}`}
          alt="Attached image"
          loading="lazy"
        />
      )
    case 'review':
      return (
        <div className={`chat-compact chat-review chat-review--${part.verdict}`}>
          {part.verdict === 'approved' ? 'Approved' : 'Changes requested'}
        </div>
      )
    case 'approval':
      return <ApprovalCard approvalId={part.approvalId} />
    case 'plan':
      return <PlanCard part={part} agents={agents} />
  }
}

export function MessageItem({ message, agents }: { message: Message; agents: AgentSummary[] }) {
  const author = message.author
  const agent =
    author.kind === 'agent' ? agents.find((item) => item.id === author.agentId) : undefined
  const you = author.kind === 'you'
  const name = you ? 'You' : (agent?.name ?? (author.kind === 'agent' ? author.agentId : 'Agent'))
  return (
    <article
      className={`chat-message${you ? ' chat-message--you' : ''}`}
      aria-label={`Message from ${name}`}
    >
      {!you && agent && <AgentGlyph agent={agent} size="sm" decorative />}
      <div className="chat-message-body">
        <div className="chat-message-meta">
          <strong style={agent && { color: agentTextColor(agent.style.color) }}>{name}</strong>
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          {message.streaming && <span className="chat-streaming">Writing…</span>}
        </div>
        <div
          className="chat-message-parts"
          aria-live={message.streaming ? 'polite' : 'off'}
          aria-atomic="false"
        >
          {message.parts.map((part, index) => (
            <Part key={index} part={part} agents={agents} />
          ))}
        </div>
      </div>
    </article>
  )
}

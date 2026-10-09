import type { AgentSummary, Message, MessagePart } from '@score/contract'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import { copyText } from '../../data/clipboard.ts'
import { newId } from '../../data/ids.ts'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentTextColor } from './agent-text-color.ts'
import { ApprovalCard } from './ApprovalCard.tsx'
import { requestDelete } from './message-deletion.ts'
import { startEdit } from './message-edit.ts'
import { PlanCard } from './PlanCard.tsx'

function Part({
  part,
  agents,
  message,
}: {
  part: MessagePart
  agents: AgentSummary[]
  message: Message
}) {
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
      return <PlanCard part={part} agents={agents} roomId={message.roomId} messageId={message.id} />
  }
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  )
}
const ICONS = {
  edit: (
    <Icon>
      <path d="M2.5 13.5 L3 10.5 L10.8 2.7 A1.4 1.4 0 0 1 12.8 4.7 L5 12.5 Z" />
    </Icon>
  ),
  copy: (
    <Icon>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 3.5 V3.3 A1.3 1.3 0 0 0 9.2 2 H3.8 A1.3 1.3 0 0 0 2.5 3.3 V8.7 A1.3 1.3 0 0 0 3.8 10 H4" />
    </Icon>
  ),
  retry: (
    <Icon>
      <path d="M13 8 A5 5 0 1 1 11.4 4.4" />
      <path d="M13.2 2.2 V5 H10.4" />
    </Icon>
  ),
  delete: (
    <Icon>
      <path d="M3 4.5 H13 M6.5 4.5 V3 H9.5 V4.5 M4.5 4.5 L5 13.5 H11 L11.5 4.5" />
    </Icon>
  ),
}

function Action({
  label,
  name,
  icon,
  onClick,
  title,
  disabled,
}: {
  label: string
  name: string
  icon: keyof typeof ICONS
  onClick: () => void
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="chat-action"
      aria-label={name}
      title={title ?? name}
      disabled={disabled}
      onClick={onClick}
    >
      {ICONS[icon]}
      <span className="chat-action-label">{label}</span>
    </button>
  )
}

/** Actions under a finished message (PLAN 5.24): Edit/Copy/Delete on yours, Copy/Retry/Delete on an agent reply. */
function MessageActions({ message, name }: { message: Message; name: string }) {
  const you = message.author.kind === 'you'
  const [copied, setCopied] = useState(false)
  const [retry, setRetry] = useState<'idle' | 'busy' | 'queued'>('idle')
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])
  const text = message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n')
  async function copy() {
    if (!(await copyText(text))) return
    setCopied(true)
    timers.current.push(setTimeout(() => setCopied(false), 2000))
  }
  async function retryReply() {
    setRetry('busy')
    setError(null)
    try {
      await apiFetch(
        `rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/retry`,
        { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
      )
      setRetry('queued')
      timers.current.push(setTimeout(() => setRetry('idle'), 2000))
    } catch (failure) {
      setRetry('idle')
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'Can’t retry right now: it is already being answered, or work is paused.'
          : 'Could not retry. Please try again.',
      )
    }
  }
  return (
    <div
      className="chat-message-actions"
      role="group"
      aria-label={`Actions for message from ${name}`}
    >
      {you && !message.editedBy && (
        <Action
          label="Edit"
          name={`Edit message from ${name}`}
          icon="edit"
          title="Edit and send again"
          onClick={() => startEdit(message)}
        />
      )}
      {text && (
        <Action
          label={copied ? 'Copied' : 'Copy'}
          name={`Copy message from ${name}`}
          icon="copy"
          onClick={() => void copy()}
        />
      )}
      {!you && (
        <Action
          label={retry === 'queued' ? 'Retrying' : 'Retry'}
          name={`Retry reply from ${name}`}
          icon="retry"
          title="Ask the agent to answer again"
          disabled={retry !== 'idle'}
          onClick={() => void retryReply()}
        />
      )}
      <Action
        label="Delete"
        name={`Delete message from ${name}`}
        icon="delete"
        title="Removes it from Score. Agents may still remember it."
        onClick={() => requestDelete(message.roomId, message.id)}
      />
      {copied && (
        <span className="chat-sr-only" role="status">
          Copied
        </span>
      )}
      {error && (
        <span className="chat-action-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function MessageItem({ message, agents }: { message: Message; agents: AgentSummary[] }) {
  const author = message.author
  const agent =
    author.kind === 'agent' ? agents.find((item) => item.id === author.agentId) : undefined
  const you = author.kind === 'you'
  const name = you ? 'You' : (agent?.name ?? (author.kind === 'agent' ? author.agentId : 'Agent'))
  return (
    <article
      id={`message-${message.id}`}
      className={`chat-message${you ? ' chat-message--you' : ''}${message.editedBy ? ' chat-message--edited' : ''}`}
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
          {message.editedBy && <span className="chat-edited">edited</span>}
        </div>
        <div
          className="chat-message-parts"
          aria-live={message.streaming ? 'polite' : 'off'}
          aria-atomic="false"
        >
          {message.parts.map((part, index) => (
            <Part key={index} part={part} agents={agents} message={message} />
          ))}
        </div>
        {message.editedBy && (
          <button
            type="button"
            className="chat-edited-link"
            onClick={() =>
              document
                .getElementById(`message-${message.editedBy}`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          >
            see the new version
          </button>
        )}
        {!message.streaming && !message.id.startsWith('pending-') && (
          <MessageActions message={message} name={name} />
        )}
      </div>
    </article>
  )
}

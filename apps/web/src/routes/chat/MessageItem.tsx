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
import { Markdown } from './Markdown.tsx'
import { DocumentChip, WorkspaceChip } from './DocumentChips.tsx'
import { PlanCard } from './PlanCard.tsx'
import { RewindDialog } from './RewindDialog.tsx'
import { SummaryCard } from './SummaryCard.tsx'
import { approvalsQuery } from './queries.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { MODEL_DIDNT_ANSWER, formatElapsed, isNotProcessedNotice, stalledFor } from './stall.ts'

/** Expand all / Collapse all (PLAN 5.25): a counter, so pressing the same button twice still reaches cards opened by hand. */
type Expansion = { open: boolean; version: number }

const STATUS_LABEL = { running: 'Running', ok: 'Done', error: 'Failed' } as const

function ToolCard({
  part,
  expansion,
  live,
}: {
  part: Extract<MessagePart, { kind: 'tool' }>
  expansion: Expansion
  live: boolean
}) {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(expansion.version)
  if (seen !== expansion.version) {
    // Adjusting state while rendering: Expand all / Collapse all overrides what was opened by hand.
    setSeen(expansion.version)
    setOpen(expansion.open)
  }
  // A tool that never reported back in a finished reply is not "running" any more.
  const status = part.status === 'running' && !live ? 'ok' : part.status
  return (
    <details
      className={`chat-card chat-tool chat-tool--${status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <code className="chat-tool-name">{part.tool}</code>
        <span className="chat-tool-args">{part.args}</span>
        <span className="chat-tool-status">{STATUS_LABEL[status]}</span>
      </summary>
      {part.args && (
        <pre className="chat-tool-body" aria-label="Arguments">
          {part.args}
        </pre>
      )}
      {part.result && (
        <pre className="chat-tool-body" aria-label="Result">
          {part.result}
        </pre>
      )}
    </details>
  )
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <details className="chat-card chat-thinking">
      <summary>{streaming ? 'Thinking…' : 'Thought process'}</summary>
      <p>{text}</p>
    </details>
  )
}

function Part({
  part,
  agents,
  message,
  expansion,
  authorName,
  readOnly,
}: {
  part: MessagePart
  agents: AgentSummary[]
  message: Message
  expansion: Expansion
  authorName: string
  readOnly: boolean
}) {
  switch (part.kind) {
    case 'summary':
      return (
        <SummaryCard part={part} message={message} authorName={authorName} readOnly={readOnly} />
      )
    case 'text':
      if (!message.streaming && message.author.kind === 'agent' && isNotProcessedNotice(part.text))
        return (
          <p className="chat-model-failed" role="status">
            {MODEL_DIDNT_ANSWER}
          </p>
        )
      return (
        <>
          {part.via === 'mcp' && <span className="chat-via-mcp">via MCP</span>}
          <Markdown
            text={part.text}
            streaming={message.streaming}
            workspace={{
              agentId: message.author.kind === 'agent' ? message.author.agentId : null,
              agentIds: agents.map((agent) => agent.id),
            }}
          />
        </>
      )
    case 'tool':
      return <ToolCard part={part} expansion={expansion} live={message.streaming} />
    case 'thinking':
      return <Thinking text={part.text} streaming={message.streaming} />
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
    case 'document':
      return <DocumentChip part={part} />
    case 'workspace':
      return <WorkspaceChip part={part} />
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
function MessageActions({
  message,
  name,
  agents,
  imported,
}: {
  message: Message
  name: string
  agents: AgentSummary[]
  imported: boolean
}) {
  const you = message.author.kind === 'you'
  const [copied, setCopied] = useState(false)
  const [retry, setRetry] = useState<'idle' | 'busy' | 'queued'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
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
      {you && !imported && !message.editedBy && (
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
      {!you && !imported && (
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
        title={
          you && !imported
            ? 'Hides it and everything after it, and rewinds the agents'
            : 'Removes it from Score. Agents may still remember it.'
        }
        onClick={() =>
          you && !imported ? setConfirming(true) : requestDelete(message.roomId, message.id)
        }
      />
      {confirming && (
        <RewindDialog
          roomId={message.roomId}
          messageId={message.id}
          mode="delete"
          agents={agents}
          onDone={() => setConfirming(false)}
          onClose={() => setConfirming(false)}
        />
      )}
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

/** Shown only while stalled: asks the approvals list, because a reply waiting for the person is not stalled. */
function StalledLine({ message, elapsed }: { message: Message; elapsed: number }) {
  const { data } = useStreamQuery(approvalsQuery)
  const runId = message.refs.find((ref) => ref.kind === 'run')?.runId
  const waitingForYou = Boolean(
    runId &&
    data?.some(
      (approval) =>
        approval.status === 'pending' &&
        approval.refs.some((ref) => ref.kind === 'run' && ref.runId === runId),
    ),
  )
  if (waitingForYou) return null
  return (
    <span className="chat-stalled" role="status">
      Waiting for the model ({formatElapsed(elapsed)}). Hermes may be retrying after a rate limit or
      a provider error.
    </span>
  )
}

function useNow(every: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

function StopReply({ message, name }: { message: Message; name: string }) {
  const now = useNow(5_000)
  const elapsed = stalledFor(message, now)
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  async function stop() {
    setState('busy')
    try {
      await apiFetch(
        `rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/stop`,
        { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
      )
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return (
    <div className="chat-stop-row">
      {elapsed !== null && <StalledLine message={message} elapsed={elapsed} />}
      <button
        type="button"
        className="chat-stop-reply"
        aria-label={`Stop reply from ${name}`}
        disabled={state === 'busy'}
        onClick={() => void stop()}
      >
        {state === 'busy' ? 'Stopping…' : 'Stop'}
      </button>
      {state === 'failed' && (
        <span className="chat-action-error" role="alert">
          Could not stop it. It may have just finished.
        </span>
      )}
    </div>
  )
}

export function MessageItem({
  message,
  agents,
  readOnly = false,
  importedLabel,
  versionControl,
}: {
  message: Message
  agents: AgentSummary[]
  /** A message of a previous version (PLAN 5.33): greyed, no actions. */
  readOnly?: boolean
  /** Where an imported copy came from ("Telegram"); such messages cannot be edited or retried. */
  importedLabel?: string | undefined
  /** The `‹ 2 / 3 ›` control of an edited message (PLAN 5.35), shown in the action row. */
  versionControl?: ReactNode
}) {
  const imported = message.id.startsWith('import:')
  const author = message.author
  const agent =
    author.kind === 'agent' ? agents.find((item) => item.id === author.agentId) : undefined
  const you = author.kind === 'you'
  const name = you ? 'You' : (agent?.name ?? (author.kind === 'agent' ? author.agentId : 'Agent'))
  const [expansion, setExpansion] = useState<Expansion>({ open: false, version: 0 })
  const showActions =
    !message.streaming &&
    !message.id.startsWith('pending-') &&
    !message.parts.some((part) => part.kind === 'summary')
  const cards = message.parts.filter((part) => part.kind === 'tool').length
  return (
    <article
      id={`message-${message.id}`}
      className={`chat-message${you ? ' chat-message--you' : ''}${message.editedBy ? ' chat-message--edited' : ''}${readOnly ? ' chat-message--previous' : ''}`}
      aria-label={`Message from ${name}`}
      tabIndex={-1}
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
          {imported && importedLabel && (
            <span className="chat-imported-chip">from {importedLabel}</span>
          )}
        </div>
        <div
          className="chat-message-parts"
          aria-live={message.streaming ? 'polite' : 'off'}
          aria-atomic="false"
        >
          {cards >= 3 && (
            <button
              type="button"
              className="chat-expand-all"
              onClick={() =>
                setExpansion((current) => ({
                  open: current.version === 0 ? true : !current.open,
                  version: current.version + 1,
                }))
              }
            >
              {expansion.version > 0 && expansion.open ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {message.parts.map((part, index) => (
            <Part
              key={index}
              part={part}
              agents={agents}
              message={message}
              expansion={expansion}
              authorName={name}
              readOnly={readOnly}
            />
          ))}
        </div>
        {!readOnly && message.streaming && !you && !message.id.startsWith('pending-') && (
          <StopReply message={message} name={name} />
        )}
        {!readOnly && message.editedBy && (
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
        {(versionControl || (!readOnly && showActions)) && (
          <div className="chat-message-foot">
            {versionControl}
            {!readOnly && showActions && (
              <MessageActions message={message} name={name} agents={agents} imported={imported} />
            )}
          </div>
        )}
      </div>
    </article>
  )
}

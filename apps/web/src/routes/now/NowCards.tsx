import type {
  AgentSummary,
  Approval,
  ApprovalChoice,
  Message,
  NowSnapshot,
  Ref,
} from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useArrival } from '../../motion/Arrival.tsx'
import { TodoItems, todoProgress, useAgentTodos } from '../../components/TodoList.tsx'
import '../../components/todo.css'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentTextColor } from '../chat/agent-text-color.ts'
import { approvalOutcome, choiceText, useApprovalDecision } from '../chat/ApprovalCard.tsx'
import { Composer } from '../chat/Composer.tsx'
import { roomsQuery } from '../chat/queries.ts'

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function messageText(message: Message): string {
  return message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
}

function partNote(message: Message): string {
  if (message.parts.some((part) => part.kind === 'approval')) return 'Asked for your approval.'
  if (message.parts.some((part) => part.kind === 'plan')) return 'Proposed a plan.'
  if (message.parts.some((part) => part.kind === 'file')) return 'Changed files.'
  return ''
}

export function ThreadCard({
  thread,
  agents,
}: {
  thread: NowSnapshot['thread']
  agents: AgentSummary[]
}) {
  return (
    <section className="now-card now-thread" aria-label="Thread">
      <div className="now-card-head">
        <h2>Thread</h2>
        <span className="now-card-sub">Latest from the room</span>
        <span className="now-grow" />
        {thread && <Link to={`/chat/${encodeURIComponent(thread.roomId)}`}>Open in Chat</Link>}
      </div>
      <div className="now-messages" aria-live="polite">
        {!thread || thread.messages.length === 0 ? (
          <p className="now-empty">No messages yet. Tell the team what you need below.</p>
        ) : (
          thread.messages.map((message, index) => {
            const { author } = message
            const agent =
              author.kind === 'agent'
                ? agents.find((item) => item.id === author.agentId)
                : undefined
            const name = message.author.kind === 'you' ? 'You' : (agent?.name ?? 'Agent')
            const text = messageText(message) || partNote(message)
            return (
              <article key={message.id} className="now-message">
                {agent ? (
                  <AgentGlyph agent={agent} size="sm" />
                ) : (
                  <span className="now-you" aria-hidden="true">
                    {name.slice(0, 1)}
                  </span>
                )}
                <div className="now-message-body">
                  <div className="now-message-meta">
                    <span
                      className="now-message-name"
                      style={agent ? { color: agentTextColor(agent.style.color) } : undefined}
                    >
                      {name}
                    </span>
                    <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
                  </div>
                  <p
                    className={index === 0 && thread.messages.length > 1 ? 'now-message-lead' : ''}
                  >
                    {text}
                    {message.streaming && <span className="now-sr-only"> (writing)</span>}
                  </p>
                </div>
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}

/** The Hermes todo list of an agent that is working right now; nothing is shown when it has none. */
export function TodoCard({ agent }: { agent: AgentSummary }) {
  const todos = useAgentTodos(agent.id, true).data
  if (!todos || todos.todos.length === 0) return null
  return (
    <section className="now-card now-todo" aria-label={`Todo of ${agent.name}`}>
      <div className="now-card-head">
        <h2>Todo</h2>
        <span className="now-card-sub">
          {agent.name} · {todoProgress(todos.todos)}
        </span>
      </div>
      <TodoItems todos={todos.todos} />
    </section>
  )
}

function AskingBody({
  approval,
  agent,
  onDecided,
}: {
  approval: Approval
  agent: AgentSummary | undefined
  onDecided: (approval: Approval, text: string) => void
}) {
  const { posted, busy, error, decide } = useApprovalDecision(approval.id)
  const current = posted && approval.delivery === 'none' ? posted : approval
  const outcome = approvalOutcome(current)
  const open = current.actionable && outcome === null && !busy
  const retry = current.actionable && current.delivery === 'failed'
  async function choose(choice: ApprovalChoice) {
    const result = await decide(choice)
    if (!result) return
    // Only a confirmed delivery by you counts as "approved"/"denied"; a queued one is just queued.
    if (result.delivery === 'applied' && result.decision?.by === 'you')
      onDecided(result, choiceText[result.decision.choice])
    else if (result.delivery === 'intent' || result.delivery === 'delivering')
      onDecided(result, 'Decision queued')
  }
  const name = agent?.name ?? approval.agentId
  const task = approval.refs.find((ref) => ref.kind === 'task')
  return (
    <>
      <div className="now-asking-head">
        <span className="now-asking-tile" style={{ background: agent?.style.color ?? '#9aa0ab' }}>
          {agent && (
            <AgentGlyph
              agent={{ ...agent, style: { ...agent.style, color: '#08241C' } }}
              bare
              decorative
              size="sm"
            />
          )}
        </span>
        <span>{name} is asking</span>
      </div>
      <h2>{current.title}</h2>
      {current.command && (
        <code className="now-asking-command">
          <span>{current.cwd ? `${current.cwd} $ ` : '$ '}</span>
          {current.command}
        </code>
      )}
      <p className="now-asking-note">
        {current.blocking ?? 'The rest of the team can keep working while you decide.'}
        {task && (
          <>
            {' '}
            <Link to={`/tasks/${encodeURIComponent(task.taskId)}`}>Open the task</Link>
          </>
        )}
      </p>
      <span className="now-grow" />
      {outcome !== null || busy ? (
        <p className="now-asking-outcome" role="status">
          {busy ? 'Sending…' : outcome}
        </p>
      ) : null}
      {error && (
        <p className="now-asking-note" role="alert">
          {error}
        </p>
      )}
      {(open || retry) && (
        <>
          <div className="now-asking-actions">
            {current.choices.includes('once') && (
              <button type="button" className="now-approve" onClick={() => void choose('once')}>
                Approve
              </button>
            )}
            {current.choices.includes('deny') && (
              <button type="button" className="now-deny" onClick={() => void choose('deny')}>
                Deny
              </button>
            )}
          </div>
          {current.choices.includes('always') && (
            <button type="button" className="now-always" onClick={() => void choose('always')}>
              Always allow this for {name}
            </button>
          )}
        </>
      )}
    </>
  )
}

export function AskingCard({
  approval,
  agents,
}: {
  approval: Approval | null
  agents: AgentSummary[]
}) {
  // The refreshed snapshot drops an approval once it is answered, and the next one may take its place at once;
  // keep a line saying what was decided for a moment.
  const [decided, setDecided] = useState<{ approval: Approval; text: string } | null>(null)
  useEffect(() => {
    if (!decided) return
    const timer = setTimeout(() => setDecided(null), 5000)
    return () => clearTimeout(timer)
  }, [decided])
  const card = useRef<HTMLElement>(null)
  useArrival(card, approval ? `approval-${approval.id}` : null)
  return (
    <section ref={card} className="now-card now-asking" aria-label="Needs you">
      <p className="now-asking-notice" role="status">
        {decided ? `${decided.text}: ${decided.approval.title}` : ''}
      </p>
      {approval ? (
        <AskingBody
          key={approval.id}
          approval={approval}
          agent={agents.find((item) => item.id === approval.agentId)}
          onDecided={(approval, text) => setDecided({ approval, text })}
        />
      ) : (
        <>
          <h2>Nothing needs you</h2>
          <p className="now-asking-note">When an agent asks for approval, it shows up here.</p>
        </>
      )}
    </section>
  )
}

function refPath(ref: Ref): string | null {
  if (ref.kind === 'task') return `/tasks/${encodeURIComponent(ref.taskId)}`
  if (ref.kind === 'room') return `/chat/${encodeURIComponent(ref.roomId)}`
  return null
}

export function MadeTodayCard({
  items,
  agents,
}: {
  items: NowSnapshot['madeToday']
  agents: AgentSummary[]
}) {
  return (
    <section className="now-card now-made" aria-label="Made today">
      <div className="now-card-head">
        <h2>Made today</h2>
        <span className="now-grow" />
        <Link to="/tasks">All work</Link>
      </div>
      {items.length === 0 ? (
        <p className="now-empty">Nothing finished yet today.</p>
      ) : (
        <ul className="now-made-list">
          {items.map((item, index) => {
            const path = refPath(item.ref)
            return (
              <li key={`${item.title}-${index}`}>
                <div className="now-made-title">
                  {path ? <Link to={path}>{item.title}</Link> : item.title}
                </div>
                {item.files.map((file) => (
                  <div key={file.path} className="now-made-row">
                    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M4 1.5 H9.5 L12.5 4.5 V14.5 H4 Z"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="now-made-file">{file.path}</span>
                    {(file.added > 0 || file.removed > 0) && (
                      <>
                        <span className="now-added">+{file.added}</span>
                        <span className="now-removed">−{file.removed}</span>
                      </>
                    )}
                  </div>
                ))}
                {item.checks.map((check) => {
                  // passed = tick, changes requested = cross, unknown = a neutral dash: no evidence either way is never red.
                  const verdict = check.verdict
                  const word =
                    verdict === 'passed'
                      ? 'passed'
                      : verdict === 'unknown'
                        ? 'not verified'
                        : 'changes requested'
                  return (
                    <div
                      key={`${check.agentId}-${check.label}`}
                      className={`now-made-row${verdict === 'unknown' ? ' now-made-row--unknown' : ''}`}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d={
                            verdict === 'passed'
                              ? 'M3 8.5 L6.5 12 L13 4.5'
                              : verdict === 'unknown'
                                ? 'M4 8 H12'
                                : 'M4 4 L12 12 M12 4 L4 12'
                          }
                          stroke={
                            verdict === 'passed'
                              ? '#00785A'
                              : verdict === 'unknown'
                                ? 'var(--ink-muted)'
                                : '#B01E43'
                          }
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="now-made-check">
                        {check.label}
                        {verdict === 'unknown' ? (
                          <span className="now-made-note"> · {word}</span>
                        ) : (
                          <span className="now-sr-only"> {word}</span>
                        )}
                      </span>
                      <span className="now-made-agent">
                        {agents.find((agent) => agent.id === check.agentId)?.name ?? check.agentId}
                      </span>
                    </div>
                  )
                })}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** The Chat composer, posting to the thread's room (or the first room when nothing has been said yet). */
export function NowComposer({ roomId, agents }: { roomId: string | null; agents: AgentSummary[] }) {
  const rooms = useStreamQuery(roomsQuery)
  // The latest thread may be a direct conversation, so look in both collections.
  const all = rooms.data ? [...rooms.data.rooms, ...rooms.data.directs] : []
  const room = all.find((item) => item.id === roomId) ?? (roomId === null ? all[0] : undefined)
  return (
    <div className="now-composer">
      {room ? (
        <Composer key={room.id} roomId={room.id} roomName={room.name} agents={agents} />
      ) : (
        <p className="now-empty" role="status">
          {rooms.status === 'pending'
            ? 'Loading rooms…'
            : 'Create a room in Chat to talk to the team.'}
        </p>
      )}
    </div>
  )
}

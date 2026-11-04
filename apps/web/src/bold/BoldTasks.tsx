import type { AgentSummary, Room, TaskColumn, TaskDetail, TaskSummary } from '@score/contract'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery, roomsQuery } from '../routes/chat/queries.ts'
import { useApprovalDecision, approvalOutcome } from '../routes/chat/ApprovalCard.tsx'
import { agentDisplayName, agentNameColor, onTeam } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'
import {
  BOARD_COLUMNS,
  DONE_LIMIT,
  boardColumn,
  elapsedLabel,
  filterTasks,
  groupTasks,
  progressPercent,
  roomChoices,
} from './bold-tasks-model.ts'
import {
  allTasksQuery,
  blockedTask,
  taskAction,
  taskBlockedReason,
  taskStateLabel,
  useTaskDetail,
  useTaskRefresh,
} from './room/task-queries.ts'
import './bold-tasks.css'

// 3.16.0: the Tasks board, back in the new shell (the Kanban board went in 11.11). Every Hermes task across rooms in
// columns. Agents move their own tasks, so there is no drag and no create or edit: the person acts on what needs them
// (unblock, an approval, a comment). Mock-up: docs/design/bold/mockups/13-tasks-board*.dc.html.

const PHONE = '(max-width: 600px)'
// The details panel sits beside the board from here; below it the panel opens as a side sheet.
const WIDE = '(min-width: 1280px)'
const PHONE_TABS: TaskColumn[] = ['working', 'planned', 'in_review', 'done']

type Lookup = {
  agents: AgentSummary[]
  rooms: Room[]
}

const agentOf = (lookup: Lookup, id: string | null) =>
  id ? lookup.agents.find((agent) => agent.id === id) : undefined
const roomName = (lookup: Lookup, id: string | null) =>
  id ? (lookup.rooms.find((room) => room.id === id)?.name ?? 'Room') : 'No room'

function describeFailure(failure: unknown, verb: string): string {
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && failure.status === 409) return failure.message
  return `Couldn’t ${verb} this task. Try again.`
}

/** One POST to the task's actions route; the key is kept across retries and renewed after a 4xx (as the room's form). */
function useTaskPost(taskId: string, action: 'unblock' | 'comment') {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  const refresh = useTaskRefresh()
  async function run(text?: string) {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await taskAction(taskId, action, text, key.current)
      setSent(true)
      key.current = newId()
      refresh()
      return true
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        key.current = newId()
      setError(describeFailure(failure, action))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, sent, error, run }
}

function AgentTag({ agent }: { agent: AgentSummary | undefined }) {
  if (!agent) return <span className="bold-tb-agent bold-tb-agent--none">Unassigned</span>
  return (
    <span className="bold-tb-agent" style={{ color: agentNameColor(agent) }}>
      <AgentGlyph agent={agent} size="xs" bare decorative />
      {agentDisplayName(agent)}
    </span>
  )
}

function TaskBadge({ task }: { task: TaskSummary }) {
  if (!task.badge) return null
  return (
    <span className={`bold-tb-badge bold-tb-badge--${task.badge.kind}`}>{task.badge.label}</span>
  )
}

function Progress({ task }: { task: TaskSummary }) {
  const percent = progressPercent(task)
  if (percent === null) return null
  return (
    <span
      className="bold-tb-progress"
      role="progressbar"
      aria-label={`Progress on ${task.title}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  )
}

function CardBody({ task, lookup }: { task: TaskSummary; lookup: Lookup }) {
  return (
    <>
      <span className="bold-tb-card-top">
        <span>{task.key}</span>
        <span>{roomName(lookup, task.roomId)}</span>
      </span>
      <span className="bold-tb-card-title">{task.title}</span>
      <TaskBadge task={task} />
      <Progress task={task} />
      <span className="bold-tb-card-foot">
        <AgentTag agent={agentOf(lookup, task.assignee)} />
        <span className="bold-tb-time">{elapsedLabel(task)}</span>
      </span>
    </>
  )
}

function TaskCard({
  task,
  lookup,
  selected,
  onPick,
}: {
  task: TaskSummary
  lookup: Lookup
  selected: boolean
  onPick: () => void
}) {
  const needs = boardColumn(task) === 'needs_you'
  return (
    <button
      type="button"
      className={`bold-tb-card${needs ? ' bold-tb-need' : ''}`}
      // A card that waits for the person is a decision marker no theme may hide.
      data-protected={needs ? 'flex' : undefined}
      aria-pressed={selected}
      aria-label={`${task.key} ${task.title}`}
      onClick={onPick}
    >
      <CardBody task={task} lookup={lookup} />
    </button>
  )
}

function Column({
  id,
  title,
  tasks,
  lookup,
  selectedId,
  onPick,
  filtered,
}: {
  id: TaskColumn
  title: string
  tasks: TaskSummary[]
  lookup: Lookup
  selectedId: string | null
  onPick: (id: string) => void
  filtered: boolean
}) {
  const [older, setOlder] = useState(false)
  const shown = id === 'done' && !older ? tasks.slice(0, DONE_LIMIT) : tasks
  const hidden = tasks.length - shown.length
  return (
    <section className="bold-tb-col" aria-label={title} data-column={id}>
      <h2>
        <span>{title}</span>
        <span className="bold-tb-count">{tasks.length}</span>
      </h2>
      {shown.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          lookup={lookup}
          selected={task.id === selectedId}
          onPick={() => onPick(task.id)}
        />
      ))}
      {hidden > 0 && (
        <button type="button" className="btn sm ghost" onClick={() => setOlder(true)}>
          Show older ({hidden})
        </button>
      )}
      {tasks.length === 0 && (
        <p className="bold-tb-empty">
          {filtered ? 'Nothing here for this filter.' : 'Nothing here.'}
        </p>
      )}
    </section>
  )
}

function TaskApproval({ detail }: { detail: TaskDetail }) {
  const approval = detail.pendingApproval
  const { posted, busy, error, decide } = useApprovalDecision(approval?.id ?? '')
  if (!approval) return null
  const current = posted && approval.delivery === 'none' ? posted : approval
  const outcome = approvalOutcome(current)
  const open = current.actionable && outcome === null && !busy
  return (
    <div className="bold-tb-approval">
      <b>{current.title}</b>
      {current.command && <code className="bold-tb-command">{current.command}</code>}
      {!current.actionable && outcome === null && (
        <span>Answer this in Hermes where the task was created.</span>
      )}
      {current.actionable && outcome === null && (
        <span className="bold-tb-actions">
          {current.choices.includes('once') && (
            <button
              type="button"
              className="btn sm"
              disabled={!open}
              onClick={() => void decide('once')}
            >
              Allow
            </button>
          )}
          {current.choices.includes('deny') && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={!open}
              onClick={() => void decide('deny')}
            >
              Don’t allow
            </button>
          )}
        </span>
      )}
      {(busy || outcome) && <span role="status">{busy ? 'Sending…' : outcome}</span>}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

function NeedsBlock({ task, detail }: { task: TaskSummary; detail: TaskDetail | undefined }) {
  const unblock = useTaskPost(task.id, 'unblock')
  const approval = detail?.pendingApproval ?? null
  const blocked = blockedTask(task)
  if (!blocked && !approval) return null
  return (
    <div className="bold-tb-needs-block" data-protected="flex" aria-label="Needs you">
      <span className="bold-tb-kicker">Needs you</span>
      {approval ? (
        <TaskApproval detail={detail!} />
      ) : (
        <>
          <p>{taskBlockedReason(task)}</p>
          <span className="bold-tb-actions">
            <button
              type="button"
              className="btn sm"
              disabled={unblock.busy || unblock.sent}
              onClick={() => void unblock.run()}
            >
              {unblock.sent ? 'Sent' : unblock.busy ? 'Sending…' : 'Unblock'}
            </button>
          </span>
          {unblock.sent && <span role="status">Sent — waiting for Hermes</span>}
          {unblock.error && (
            <span className="bold-request-error" role="alert">
              {unblock.error}
            </span>
          )}
        </>
      )}
      <Link className="bold-tb-room-link" to="/b">
        Open in its room
      </Link>
    </div>
  )
}

function CommentBox({ task, agent }: { task: TaskSummary; agent: AgentSummary | undefined }) {
  const [text, setText] = useState('')
  const post = useTaskPost(task.id, 'comment')
  const id = useId()
  async function submit() {
    if (!text.trim()) return
    if (await post.run(text)) setText('')
  }
  return (
    <form
      className="bold-tb-comment-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={id}>Add a comment for {agent ? agentDisplayName(agent) : 'the team'}</label>
      <span className="bold-tb-comment-row">
        <input
          id={id}
          type="text"
          value={text}
          maxLength={2000}
          disabled={post.busy}
          placeholder="Say what to change or check"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="btn sm ghost" disabled={post.busy || !text.trim()}>
          Comment
        </button>
      </span>
      {post.sent && !post.error && <span role="status">Sent — waiting for Hermes</span>}
      {post.error && (
        <span className="bold-request-error" role="alert">
          {post.error}
        </span>
      )}
    </form>
  )
}

const when = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

function TaskPanel({
  task,
  lookup,
  onClose,
}: {
  task: TaskSummary
  lookup: Lookup
  onClose: () => void
}) {
  const detailQuery = useTaskDetail(task.id)
  const detail = detailQuery.data
  const agent = agentOf(lookup, task.assignee)
  const reviewer = agentOf(lookup, task.reviewer)
  const column =
    BOARD_COLUMNS.find((item) => item.id === boardColumn(task))?.title ?? taskStateLabel(task)
  return (
    <div className="bold-tb-panel-body">
      <span className="bold-tb-panel-top">
        <span>
          {task.key} · Hermes: {task.hermesStatus}
        </span>
        <button
          type="button"
          className="bold-tb-close"
          aria-label="Close task details"
          onClick={onClose}
        >
          ×
        </button>
      </span>
      <h2>{task.title}</h2>
      <dl className="bold-tb-facts">
        <dt>Room</dt>
        <dd>{task.roomId ? <Link to="/b">{roomName(lookup, task.roomId)}</Link> : 'No room'}</dd>
        <dt>Doing it</dt>
        <dd>
          <AgentTag agent={agent} />
        </dd>
        <dt>Reviewer</dt>
        <dd>{reviewer ? <AgentTag agent={reviewer} /> : 'None'}</dd>
        <dt>Column</dt>
        <dd>{column}</dd>
      </dl>
      <NeedsBlock task={task} detail={detail} />
      <section className="bold-tb-section" aria-label="Steps">
        <h3>Steps</h3>
        {detailQuery.isPending && <p className="bold-tb-empty">Reading steps…</p>}
        {detailQuery.isError && <p className="bold-tb-empty">Couldn’t read its steps.</p>}
        {detail && detail.steps.length === 0 && <p className="bold-tb-empty">No steps yet.</p>}
        {detail && detail.steps.length > 0 && (
          <ul className="bold-tb-steps">
            {detail.steps.map((step) => (
              <li key={step.id} data-done={step.done ? 'true' : 'false'}>
                <span className="bold-tb-box" aria-hidden="true">
                  {step.done ? '✓' : ''}
                </span>
                <span>{step.text}</span>
                <span className="bold-tb-sr">{step.done ? 'done' : 'not done'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="bold-tb-section" aria-label="Comments">
        <h3>Comments</h3>
        {detail?.activity.map((entry, index) => {
          const who = agentOf(lookup, entry.agentId)
          return (
            <div className="bold-tb-comment" key={`${entry.at}-${index}`}>
              <span>
                <strong>{who ? agentDisplayName(who) : 'You'}</strong> · {when(entry.at)}
              </span>
              <span>{entry.text}</span>
            </div>
          )
        })}
        {detail && detail.activity.length === 0 && (
          <p className="bold-tb-empty">No comments yet.</p>
        )}
        <CommentBox task={task} agent={agent} />
      </section>
    </div>
  )
}

function Sheet({
  children,
  onClose,
  side = false,
}: {
  children: React.ReactNode
  onClose: () => void
  /** 601-1279px: a sheet on the right over the board instead of the phone's full screen. */
  side?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  // The page re-renders on every stream event with a new onClose: read it through a ref so focus moves only when the
  // sheet opens and closes, never while someone is typing in it.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus?.()
    }
  }, [])
  return (
    <div
      ref={ref}
      className={`bold-tb-sheet${side ? ' bold-tb-sheet--side' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Task details"
      tabIndex={-1}
    >
      {children}
    </div>
  )
}

function PhoneNeedsCard({
  task,
  lookup,
  onOpen,
}: {
  task: TaskSummary
  lookup: Lookup
  onOpen: () => void
}) {
  const unblock = useTaskPost(task.id, 'unblock')
  // Unblock only what Hermes itself has blocked (it refuses the rest); anything else in Needs you, such as a task
  // waiting on an approval, is decided in its details, where the approval is (the summary doesn't carry it).
  const blocked = task.hermesStatus === 'blocked'
  const reason = taskBlockedReason(task)
  return (
    <article className="bold-tb-need bold-tb-need--phone" data-protected="flex">
      <CardBody task={task} lookup={lookup} />
      {reason && reason !== task.badge?.label && <span>{reason}</span>}
      <span className="bold-tb-actions">
        {blocked ? (
          <>
            <button
              type="button"
              className="btn sm"
              disabled={unblock.busy || unblock.sent}
              onClick={() => void unblock.run()}
            >
              {unblock.sent ? 'Sent' : unblock.busy ? 'Sending…' : 'Unblock'}
            </button>
            <button type="button" className="btn sm ghost bold-tb-need-more" onClick={onOpen}>
              Details
            </button>
          </>
        ) : (
          <button type="button" className="btn sm" onClick={onOpen}>
            Review and decide
          </button>
        )}
      </span>
      {unblock.sent && <span role="status">Sent — waiting for Hermes</span>}
      {unblock.error && (
        <span className="bold-request-error" role="alert">
          {unblock.error}
        </span>
      )}
    </article>
  )
}

function Chips<T extends string>({
  label,
  options,
  value,
  onPick,
  className,
}: {
  label: string
  options: { id: T | null; label: string; agent?: AgentSummary }[]
  value: T | null
  onPick: (id: T | null) => void
  className?: string
}) {
  return (
    <div
      className={`bold-tb-chips${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id ?? 'all'}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onPick(option.id)}
        >
          {option.agent && <AgentGlyph agent={option.agent} size="xs" bare decorative />}
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** The route: `/b/tasks`. */
export function BoldTasksPage() {
  const phone = useMediaQuery(PHONE)
  const wide = useMediaQuery(WIDE)
  const tasksState = useStreamQuery(allTasksQuery)
  const agentsState = useStreamQuery(agentsQuery)
  const roomsState = useStreamQuery(roomsQuery)
  const agents = useMemo(() => (agentsState.data ?? []).filter(onTeam), [agentsState.data])
  const rooms = useMemo(() => roomsState.data?.rooms ?? [], [roomsState.data])
  const lookup = useMemo<Lookup>(() => ({ agents, rooms }), [agents, rooms])
  const all = useMemo(() => tasksState.data?.tasks ?? [], [tasksState.data])
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [roomFilter, setRoomFilter] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [phoneTab, setPhoneTab] = useState<TaskColumn>('working')

  const roomIds = useMemo(() => roomChoices(all), [all])
  const activeRoom = roomFilter !== null && roomIds.includes(roomFilter) ? roomFilter : null
  const visible = useMemo(
    () => filterTasks(all, { agent: agentFilter, room: activeRoom }),
    [all, agentFilter, activeRoom],
  )
  const grouped = useMemo(() => groupTasks(visible), [visible])
  const needsCount = useMemo(
    () => all.filter((task) => boardColumn(task) === 'needs_you').length,
    [all],
  )
  const filtered = agentFilter !== null || activeRoom !== null
  const selected = selectedId ? (all.find((task) => task.id === selectedId) ?? null) : null

  const status = tasksState.status
  const loading = status === 'pending' && !tasksState.data
  const failed = status === 'error' && !tasksState.data
  const none = !loading && !failed && all.length === 0

  const agentOptions = [
    { id: null, label: 'Everyone' },
    ...agents.map((agent) => ({ id: agent.id, label: agentDisplayName(agent), agent })),
  ]
  const roomOptions = [
    { id: null, label: 'All rooms' },
    ...roomIds.map((id) => ({ id, label: roomName(lookup, id) })),
  ]

  return (
    <div className="bold-page bold-tb" data-ui-page="tasks">
      <header className="bold-tb-head">
        <div className="bold-tb-title">
          <h1>Tasks</h1>
          <p>
            Every Hermes task across your rooms. Agents move their own tasks; you act on the ones
            that need you.
          </p>
        </div>
        {needsCount > 0 ? (
          <span className="bold-tb-pill" data-protected="inline-flex">
            {needsCount} need you
          </span>
        ) : (
          <span className="bold-tb-quiet">Nothing needs you</span>
        )}
      </header>

      {loading && <p role="status">Reading tasks…</p>}
      {failed && <p role="alert">Couldn’t read the tasks. Try again in a moment.</p>}
      {none && (
        <p className="bold-tb-none">No tasks yet. Hermes tasks your agents create show up here.</p>
      )}

      {all.length > 0 && (
        <>
          <div className="bold-tb-filters">
            <Chips
              label="Filter by agent"
              options={agentOptions}
              value={agentFilter}
              onPick={setAgentFilter}
            />
            {roomIds.length > 0 && (
              <Chips
                label="Filter by room"
                options={roomOptions}
                value={activeRoom}
                onPick={setRoomFilter}
                className="bold-tb-chips--room"
              />
            )}
          </div>
          {filtered && visible.length === 0 && (
            <p className="bold-tb-none">No tasks match this filter.</p>
          )}

          {phone ? (
            <>
              {grouped.needs_you.length > 0 && (
                <section className="bold-tb-phone-needs" aria-label="Needs you">
                  <h2>Needs you · {grouped.needs_you.length}</h2>
                  {grouped.needs_you.map((task) => (
                    <PhoneNeedsCard
                      key={task.id}
                      task={task}
                      lookup={lookup}
                      onOpen={() => setSelectedId(task.id)}
                    />
                  ))}
                </section>
              )}
              <div className="bold-tb-tabs" role="tablist" aria-label="Columns">
                {PHONE_TABS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={phoneTab === id}
                    onClick={() => setPhoneTab(id)}
                  >
                    {BOARD_COLUMNS.find((column) => column.id === id)!.title}{' '}
                    <span>{grouped[id].length}</span>
                  </button>
                ))}
              </div>
              <div role="tabpanel" className="bold-tb-phone-list">
                <Column
                  key={phoneTab}
                  id={phoneTab}
                  title={BOARD_COLUMNS.find((column) => column.id === phoneTab)!.title}
                  tasks={grouped[phoneTab]}
                  lookup={lookup}
                  selectedId={selectedId}
                  onPick={setSelectedId}
                  filtered={filtered}
                />
              </div>
              {selected && (
                <Sheet onClose={() => setSelectedId(null)}>
                  <TaskPanel
                    key={selected.id}
                    task={selected}
                    lookup={lookup}
                    onClose={() => setSelectedId(null)}
                  />
                </Sheet>
              )}
            </>
          ) : (
            <div className={`bold-tb-layout${wide ? '' : ' is-sheet'}`}>
              <div className="bold-tb-scroll">
                <div className="bold-tb-grid">
                  {BOARD_COLUMNS.map((column) => (
                    <Column
                      key={column.id}
                      id={column.id}
                      title={column.title}
                      tasks={grouped[column.id]}
                      lookup={lookup}
                      selectedId={selectedId}
                      onPick={setSelectedId}
                      filtered={filtered}
                    />
                  ))}
                </div>
              </div>
              {wide ? (
                <aside className="bold-tb-panel" aria-label="Task details">
                  {selected ? (
                    <TaskPanel
                      key={selected.id}
                      task={selected}
                      lookup={lookup}
                      onClose={() => setSelectedId(null)}
                    />
                  ) : (
                    <p className="bold-tb-empty">
                      Pick a task to see its steps, comments and what it needs from you.
                    </p>
                  )}
                </aside>
              ) : (
                selected && (
                  <Sheet side onClose={() => setSelectedId(null)}>
                    <TaskPanel
                      key={selected.id}
                      task={selected}
                      lookup={lookup}
                      onClose={() => setSelectedId(null)}
                    />
                  </Sheet>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

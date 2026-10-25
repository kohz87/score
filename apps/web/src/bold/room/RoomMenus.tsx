import {
  JobSchema,
  type AgentSummary,
  type Job,
  type OutsideSession,
  type Room,
} from '@score/contract'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useOutsideSessions } from '../../data/outside-sessions.ts'
import { ChevronIcon, PlusIcon, TrashIcon } from '../BoldIcons.tsx'
import { useStartJob } from '../BoldStartJob.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { PhonePresence } from './PhoneJobList.tsx'
import { jobStateLine } from './room-model.ts'

function DotsIcon() {
  return (
    <span className="bold-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function useMenu(
  open: boolean,
  setOpen: (open: boolean) => void,
  root: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
) {
  function close(restoreFocus = true) {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }
  useEffect(() => {
    if (!open) return
    const first = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="menuitem"], [role="option"]')?.focus()
    })
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onFocusIn(event: FocusEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    // The room and job menus also live in the phone's side sheet: one Escape closes the menu, not both layers.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(first)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, root, setOpen, trigger])
  return close
}

function moveInMenu(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const root = event.currentTarget
  const items = [
    ...root.querySelectorAll<HTMLElement>('[role="menuitem"], [role="option"]'),
  ].filter((item) => item.getAttribute('aria-disabled') !== 'true')
  if (!items.length) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (at + 1 + items.length) % items.length
          : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

function RoomDot({ team }: { team: boolean }) {
  return <span className={`bold-room-dot${team ? ' team' : ''}`} aria-hidden="true" />
}

function isOlderRoom(room: Room): boolean {
  return room.role !== 'team' && room.kind === 'room' && !room.importedFrom
}

export function RoomSwitcher({
  current,
  teamRoom,
  teamJobCount,
  rooms,
  agents,
  onSelectRoom,
  onOpenElsewhere,
}: {
  current: Room | null
  teamRoom: Room | null
  teamJobCount: number | null
  rooms: Room[]
  agents: AgentSummary[]
  onSelectRoom: (room: Room) => void
  onOpenElsewhere: (session: OutsideSession) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const sessions = useOutsideSessions(open)
  const close = useMenu(open, setOpen, root, trigger)

  const older = rooms.filter((room) => room.id !== teamRoom?.id && isOlderRoom(room))
  const imported = rooms.filter(
    (room) =>
      room.id !== teamRoom?.id && room.role !== 'team' && room.kind === 'room' && room.importedFrom,
  )
  const chooseRoom = (room: Room) => {
    close()
    onSelectRoom(room)
  }
  const chooseOutside = (session: OutsideSession) => {
    close()
    onOpenElsewhere(session)
  }

  return (
    <span className="bold-room-switch-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="roomtitle"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {current?.name ?? 'Team room'}
        {current && isOlderRoom(current) && <span className="bold-room-kind">Older room</span>}
        <ChevronIcon />
      </button>
      {open && (
        <div
          className="menu bold-room-switch"
          id={menuId}
          role="listbox"
          aria-label="Rooms and chats elsewhere"
          onKeyDown={moveInMenu}
        >
          <div className="sec">Rooms</div>
          {teamRoom && (
            <button
              type="button"
              role="option"
              aria-selected={current?.id === teamRoom.id}
              className={`mi${current?.id === teamRoom.id ? ' sel' : ''}`}
              onClick={() => chooseRoom(teamRoom)}
            >
              <RoomDot team />
              <span className="menu-copy">
                <b>{teamRoom.name}</b>
                <span className="small muted">
                  Always on
                  {teamJobCount === null
                    ? ''
                    : ` · ${teamJobCount} ${teamJobCount === 1 ? 'job' : 'jobs'}`}
                </span>
              </span>
            </button>
          )}
          {older.map((room) => (
            <button
              key={room.id}
              type="button"
              role="option"
              aria-selected={current?.id === room.id}
              className={`mi${current?.id === room.id ? ' sel' : ''}`}
              onClick={() => chooseRoom(room)}
            >
              <RoomDot team={false} />
              <span className="menu-copy">
                <b>{room.name}</b>
                <span className="small muted">
                  {room.importedFrom
                    ? `Imported from ${room.importedFrom.label}`
                    : 'Older room · read-write with @mentions'}
                </span>
              </span>
            </button>
          ))}
          {imported.length > 0 && <div className="sec">Imported chats</div>}
          {imported.map((room) => (
            <button
              key={room.id}
              type="button"
              role="option"
              aria-selected={current?.id === room.id}
              className={`mi${current?.id === room.id ? ' sel' : ''}`}
              onClick={() => chooseRoom(room)}
            >
              <RoomDot team={false} />
              <span className="menu-copy">
                <b>{room.name}</b>
                <span className="small muted">
                  Imported from {room.importedFrom?.label ?? 'Elsewhere'} · read-write
                </span>
              </span>
            </button>
          ))}
          <div className="sec">Elsewhere · the agents’ own chats outside Score</div>
          {sessions.isPending && (
            <div className="small muted bold-menu-note" role="status">
              Looking for sessions…
            </div>
          )}
          {sessions.isError && (
            <div className="small muted bold-menu-note" role="alert">
              Couldn’t read the agents’ sessions.
            </div>
          )}
          {sessions.data?.items.map((session) => {
            return (
              <button
                key={`${session.agentId}:${session.id}`}
                type="button"
                role="option"
                aria-selected={false}
                className="mi"
                onClick={() => chooseOutside(session)}
              >
                <OutsideGlyph agent={agents.find((item) => item.id === session.agentId)} />
                <span className="menu-copy">
                  <b>
                    {(() => {
                      const agent = agents.find((item) => item.id === session.agentId)
                      return agent ? agentDisplayName(agent) : session.agentId
                    })()}{' '}
                    · {session.sourceLabel}
                  </b>
                  <span className="small muted bold-menu-preview">
                    <span
                      className="bold-menu-preview-title"
                      title={session.title || 'Untitled session'}
                    >
                      {session.title || 'Untitled session'}
                    </span>
                    <span className="bold-menu-preview-count">
                      {' · '}
                      {session.messageCount} {session.messageCount === 1 ? 'message' : 'messages'}
                      {session.busy ? ' · active now' : ''}
                    </span>
                  </span>
                </span>
              </button>
            )
          })}
          {sessions.data && sessions.data.items.length === 0 && (
            <div className="small muted bold-menu-note">Nothing yet.</div>
          )}
          {(sessions.data?.unavailable.length ?? 0) > 0 && (
            <div className="small muted bold-menu-note">
              Couldn’t read {sessions.data!.unavailable.join(', ')}.
            </div>
          )}
        </div>
      )}
    </span>
  )
}

function OutsideGlyph({ agent }: { agent: AgentSummary | undefined }) {
  return agent ? (
    <AgentGlyph agent={agent} size="sm" bare decorative />
  ) : (
    <span className="bold-outside-glyph" aria-hidden="true" />
  )
}

export function jobLifecycleError(
  error: unknown,
  action: 'close' | 'reopen' | 'delete' | 'rename',
) {
  if (error instanceof ApiError && error.status === 409)
    return error.message.includes('still working')
      ? {
          text: `This job is still working. Stop it first, then ${action} it.`,
          stillWorking: true,
        }
      : { text: error.message, stillWorking: false }
  if (error instanceof ApiError && (error.status === 401 || error.status === 403))
    return { text: 'Pair this browser first.', stillWorking: false }
  return { text: `Couldn’t ${action} this job. Try again.`, stillWorking: false }
}

export function RenameJobDialog({
  job,
  onClose,
  onRenamed,
}: {
  job: Job
  onClose: () => void
  onRenamed: (job: Job) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(job.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const valid = title.trim().length >= 1 && title.trim().length <= 200
  async function rename() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const renamed = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(job.id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': key.current },
          body: JSON.stringify({ title: title.trim() }),
        }),
      )
      onRenamed(renamed)
    } catch (failure) {
      key.current = newId()
      setError(jobLifecycleError(failure, 'rename').text)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-job-rename-dialog"
      data-protected="any"
      aria-labelledby="rename-job-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="rename-job-title">Rename job</h2>
      <label className="chat-delete-confirm">
        <span>Name</span>
        <input
          value={title}
          autoFocus
          autoComplete="off"
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void rename()
            }
          }}
        />
      </label>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={!valid || busy}
          onClick={() => void rename()}
        >
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </dialog>
  )
}

export function DeleteJobDialog({
  job,
  onClose,
  onDeleted,
  onStop,
}: {
  job: Job
  onClose: () => void
  onDeleted: () => void
  onStop: (job: Job) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stillWorking, setStillWorking] = useState(false)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const matches = typed === job.title
  async function remove() {
    if (!matches || busy) return
    setBusy(true)
    setError(null)
    setStillWorking(false)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': key.current },
      })
      onDeleted()
    } catch (failure) {
      key.current = newId()
      const problem = jobLifecycleError(failure, 'delete')
      setError(problem.text)
      setStillWorking(problem.stillWorking)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-job-delete-dialog"
      data-protected="any"
      aria-labelledby="delete-job-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="delete-job-title">Delete “{job.title}”?</h2>
      <ul className="chat-rewind-list">
        <li>Its messages and thread are removed from Score. Results saved to the Library stay.</li>
        <li>You can undo this for about 10 seconds.</li>
      </ul>
      <label className="chat-delete-confirm">
        <span>
          Type <strong>{job.title}</strong> to confirm
        </span>
        <input
          value={typed}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void remove()
            }
          }}
        />
      </label>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      {stillWorking && (
        <button type="button" className="btn sm" disabled={busy} onClick={() => onStop(job)}>
          Stop
        </button>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={!matches || busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete job'}
        </button>
      </div>
    </dialog>
  )
}

export function RoomMenu({
  room,
  onShare,
  onDelete,
}: {
  room: Room
  onShare: (room: Room) => void
  onDelete: (room: Room) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  const team = room.role === 'team'
  return (
    <span className="bold-room-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Room menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          className="menu bold-room-menu"
          id={menuId}
          role="menu"
          aria-label={`${room.name} actions`}
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          <a
            className="mi"
            role="menuitem"
            href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`}
            download
            onClick={() => {
              // Let the browser start the download before the link unmounts, then return focus.
              window.setTimeout(() => close(), 0)
            }}
          >
            Export this room
          </a>
          <button
            type="button"
            className="mi"
            role="menuitem"
            onClick={() => {
              close(false)
              onShare(room)
            }}
          >
            Share a read-only link
          </button>
          {team && (
            <div className="small muted bold-menu-note">
              Shares the selected job’s thread; under All, the team room’s default thread.
            </div>
          )}
          {team ? (
            <div className="small muted bold-menu-note">
              The team room is always on, so it can’t be deleted. Delete jobs inside it instead.
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="mi bad"
              onClick={() => {
                close(false)
                onDelete(room)
              }}
            >
              <TrashIcon />
              Delete {room.name}
            </button>
          )}
        </div>
      )}
    </span>
  )
}

export function JobMenu({
  room,
  job,
  onShare,
  onRename,
  onCloseJob,
  onReopen,
  onDelete,
}: {
  room: Room
  job: Job | undefined
  onShare: (job: Job) => void
  onRename: (job: Job) => void
  onCloseJob: (job: Job) => void
  onReopen: (job: Job) => void
  onDelete: (job: Job) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  if (!job) return null
  return (
    <span className="bold-job-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Job menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          className="menu bold-job-menu"
          id={menuId}
          role="menu"
          aria-label={`${job.title} actions`}
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          {!job.isDefault && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                onRename(job)
              }}
            >
              Rename…
            </button>
          )}
          {!job.isDefault && (
            <button
              type="button"
              className="mi"
              role="menuitem"
              onClick={() => {
                close(false)
                if (job.state === 'closed') onReopen(job)
                else onCloseJob(job)
              }}
            >
              {job.state === 'closed' ? 'Reopen' : 'Close'}
            </button>
          )}
          <button
            type="button"
            className="mi"
            role="menuitem"
            onClick={() => {
              close(false)
              onShare(job)
            }}
          >
            Share a read-only link
          </button>
          <a
            className="mi"
            role="menuitem"
            href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`}
            download
            onClick={() => {
              // Let the browser start the download before the link unmounts, then return focus.
              window.setTimeout(() => close(), 0)
            }}
          >
            Export the whole room as Markdown
          </a>
          {!job.isDefault && (
            <button
              type="button"
              className="mi bad"
              role="menuitem"
              onClick={() => {
                close(false)
                onDelete(job)
              }}
            >
              <TrashIcon />
              Delete job
            </button>
          )}
        </div>
      )}
    </span>
  )
}

export function RoomTitle({
  current,
  teamRoom,
  teamJobCount,
  rooms,
  agents,
  phoneAction,
  phone = false,
  phoneJob,
  phoneBackLabel = 'Back to jobs',
  onBackToJobs,
  onSelectRoom,
  onOpenElsewhere,
  onShare,
  onDelete,
}: {
  current: Room | null
  teamRoom: Room | null
  teamJobCount: number | null
  rooms: Room[]
  agents: AgentSummary[]
  phoneAction?: ReactNode
  /** The phone room's board 18/03 head, instead of the desktop title. */
  phone?: boolean
  /** The job whose full-screen chat is open; absent means the job list. */
  phoneJob?: Job
  phoneBackLabel?: string
  onBackToJobs?: () => void
  onSelectRoom: (room: Room) => void
  onOpenElsewhere: (session: OutsideSession) => void
  onShare: (room: Room) => void
  onDelete: (room: Room) => void
}) {
  const startJob = useStartJob()
  if (phone && phoneJob) {
    return (
      <div className="roomhead bold-phone-chat-head">
        <button
          type="button"
          className="icon-btn bold-phone-back"
          aria-label={phoneBackLabel}
          onClick={onBackToJobs}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="bold-phone-chat-id">
          <b data-phone-chat-title tabIndex={-1}>
            {phoneJob.isDefault ? (current?.name ?? 'Team room') : phoneJob.title}
          </b>
          <span>{jobStateLine(phoneJob, agents)}</span>
        </span>
        <PhonePresence agents={agents} />
      </div>
    )
  }
  if (phone) {
    return (
      <div className="roomhead bold-phone-list-head">
        <div className="bold-phone-list-title">
          <RoomSwitcher
            current={current}
            teamRoom={teamRoom}
            teamJobCount={teamJobCount}
            rooms={rooms}
            agents={agents}
            onSelectRoom={onSelectRoom}
            onOpenElsewhere={onOpenElsewhere}
          />
          <PhonePresence agents={agents} />
        </div>
        <div className="bold-phone-list-actions">
          {current && <RoomMenu room={current} onShare={onShare} onDelete={onDelete} />}
          {current?.role === 'team' && (
            <button
              type="button"
              className="chip room-start"
              aria-label="Start a job"
              onClick={() => startJob?.openStartJob()}
            >
              <PlusIcon />
              Job
            </button>
          )}
          {phoneAction}
        </div>
      </div>
    )
  }
  return (
    <div className="roomhead">
      <RoomSwitcher
        current={current}
        teamRoom={teamRoom}
        teamJobCount={teamJobCount}
        rooms={rooms}
        agents={agents}
        onSelectRoom={onSelectRoom}
        onOpenElsewhere={onOpenElsewhere}
      />
      <span className="bold-room-grow" aria-hidden="true" />
      {current && <RoomMenu room={current} onShare={onShare} onDelete={onDelete} />}
      {current?.role === 'team' && (
        <button
          type="button"
          className="chip room-start"
          aria-label="Start a job"
          onClick={() => startJob?.openStartJob()}
        >
          <PlusIcon />
          Job
        </button>
      )}
      {phoneAction}
    </div>
  )
}

/** The one-to-one head's menu: deleted messages and delete this chat (a room's default thread can't be deleted). */
export function ChatMenu({
  showDeleted,
  onToggleDeleted,
  onDelete,
}: {
  showDeleted: boolean
  onToggleDeleted: () => void
  onDelete: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const close = useMenu(open, setOpen, root, trigger)
  return (
    <span className="bold-job-menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        aria-label="Chat menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          className="menu bold-job-menu"
          id={menuId}
          role="menu"
          aria-label="Chat actions"
          data-protected="flex"
          onKeyDown={moveInMenu}
        >
          <button
            type="button"
            className="mi"
            role="menuitemcheckbox"
            aria-checked={showDeleted}
            onClick={() => {
              close()
              onToggleDeleted()
            }}
          >
            {showDeleted ? 'Hide deleted messages' : 'Show deleted messages'}
          </button>
          {onDelete && (
            <button
              type="button"
              className="mi bad"
              role="menuitem"
              onClick={() => {
                close(false)
                onDelete()
              }}
            >
              <TrashIcon />
              Delete chat
            </button>
          )}
        </div>
      )}
    </span>
  )
}

/** Deleting a one-to-one chat: a plain confirm (no typing), undoable for about 10 seconds like any job. */
export function DeleteChatDialog({
  chat,
  agentName,
  onClose,
  onDeleted,
}: {
  chat: Job
  agentName: string
  onClose: () => void
  onDeleted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function remove() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`jobs/${encodeURIComponent(chat.id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': key.current },
      })
      onDeleted()
    } catch (failure) {
      key.current = newId()
      setError(jobLifecycleError(failure, 'delete').text.replace('this job', 'this chat'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-job-delete-dialog"
      data-protected="any"
      aria-labelledby="delete-chat-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="delete-chat-title">Delete this chat with {agentName}?</h2>
      <ul className="chat-rewind-list">
        <li>
          Its messages are removed from Score. {agentName}’s own sessions in Hermes are not touched,
          so it may still remember the conversation.
        </li>
        <li>You can undo this for about 10 seconds.</li>
      </ul>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete chat'}
        </button>
      </div>
    </dialog>
  )
}

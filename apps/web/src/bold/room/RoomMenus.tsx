import type { AgentSummary, Job, OutsideSession, Room } from '@score/contract'
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
import { useOutsideSessions } from '../../data/outside-sessions.ts'
import { ChevronIcon, PlusIcon, TrashIcon } from '../BoldIcons.tsx'
import { useStartJob } from '../BoldStartJob.tsx'
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
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(first)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('keydown', onKeyDown)
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
                    {agents.find((item) => item.id === session.agentId)?.name ?? session.agentId} ·{' '}
                    {session.sourceLabel}
                  </b>
                  <span className="small muted">
                    {session.title || 'Untitled session'} · {session.messageCount}{' '}
                    {session.messageCount === 1 ? 'message' : 'messages'}
                    {session.busy ? ' · active now' : ''}
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
}: {
  room: Room
  job: Job | undefined
  onShare: (job: Job) => void
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
          aria-label="Back to jobs"
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
          <b>{phoneJob.isDefault ? (current?.name ?? 'Team room') : phoneJob.title}</b>
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

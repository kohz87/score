import type { AgentSummary, OutsideSession, Room } from '@score/contract'
import { Fragment, useId, useRef, useState, type RefObject } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useOutsideSessions } from '../../data/outside-sessions.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomsQuery } from '../../routes/chat/queries.ts'
import { groupRooms } from '../../routes/chat/room-groups.ts'
import { ChevronIcon, PlusIcon } from '../BoldIcons.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { moveInMenu, useMenu } from './menu-primitives.tsx'
import { isEveryoneRoom } from './room-model.ts'
import { isOlderRoom } from './room-menu-model.ts'
import { teamRoomsQuery } from './room-queries.ts'
import { NewTeamDialog } from './TeamDialogs.tsx'

function RoomDot({ team }: { team: boolean }) {
  return <span className={`bold-room-dot${team ? ' team' : ''}`} aria-hidden="true" />
}

export function RoomSwitcher({
  current,
  teamRoom,
  teamJobCount,
  rooms,
  agents,
  onSelectRoom,
  onOpenElsewhere,
  controlled,
}: {
  current: Room | null
  teamRoom: Room | null
  teamJobCount: number | null
  rooms: Room[]
  agents: AgentSummary[]
  onSelectRoom: (room: Room) => void
  onOpenElsewhere: (session: OutsideSession) => void
  /** The desktop header has no caret: the room ⋯ menu opens this list (older, imported and elsewhere chats). */
  controlled?: {
    open: boolean
    setOpen: (open: boolean) => void
    /** The button that opened it, so closing returns focus there. */
    returnTo?: RefObject<HTMLButtonElement | null>
  }
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlled ? controlled.open : ownOpen
  const setOpen = controlled ? controlled.setOpen : setOwnOpen
  const root = useRef<HTMLSpanElement>(null)
  const ownTrigger = useRef<HTMLButtonElement>(null)
  const trigger = controlled?.returnTo ?? ownTrigger
  const menuId = useId()
  const sessions = useOutsideSessions(open)
  const close = useMenu(open, setOpen, root, trigger)

  const [showArchived, setShowArchived] = useState(false)
  const [makingTeam, setMakingTeam] = useState(false)
  // The teams the person made. They belong here, not in the older-rooms lists (which never carry team rooms).
  const chosenTeams = (useStreamQuery(teamRoomsQuery).data ?? []).filter(
    (room) => !isEveryoneRoom(room),
  )
  const projects = useStreamQuery(roomsQuery).data?.projects ?? []
  // The room that is open stays listed even when archived, so it is never unreachable from its own switcher.
  const visible = (room: Room) => showArchived || !room.archived || room.id === current?.id
  const candidates = rooms.filter(
    (room) => room.id !== teamRoom?.id && isOlderRoom(room) && visible(room),
  )
  const groups = groupRooms(candidates, projects, { showArchived: true, tag: null })
  const imported = rooms
    .filter(
      (room) =>
        room.id !== teamRoom?.id &&
        room.role !== 'team' &&
        room.kind === 'room' &&
        room.importedFrom &&
        visible(room),
    )
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
  const visibleTeams = chosenTeams.filter(visible)
  const archivedCount =
    rooms.filter(
      (room) =>
        room.id !== teamRoom?.id && room.role !== 'team' && room.kind === 'room' && room.archived,
    ).length + chosenTeams.filter((room) => room.archived).length
  const grouped = groups.projects.some((group) => group.rooms.length > 0)
  const note = (room: Room) =>
    [room.pinned ? 'Pinned' : '', room.archived ? 'Archived' : ''].filter(Boolean).join(' · ')
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
      {!controlled && (
        <button
          ref={trigger}
          type="button"
          className="roomtitle"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen(!open)}
        >
          {current?.name ?? 'Team room'}
          {current && isOlderRoom(current) && <span className="bold-room-kind">Older room</span>}
          <ChevronIcon />
        </button>
      )}
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
          {visibleTeams.map((team) => (
            <button
              key={team.id}
              type="button"
              role="option"
              aria-selected={current?.id === team.id}
              className={`mi${current?.id === team.id ? ' sel' : ''}`}
              onClick={() => chooseRoom(team)}
            >
              <RoomDot team />
              <span className="menu-copy">
                <b>{team.name}</b>
                <span className="small muted">
                  Team of {team.members.length}
                  {team.archived ? ' · Archived' : ''}
                </span>
              </span>
            </button>
          ))}
          {[
            { key: 'pinned', title: 'Pinned', rooms: groups.pinned },
            ...groups.projects.map((group) => ({
              key: group.project.id,
              title: group.project.name,
              rooms: group.rooms,
            })),
            { key: 'rest', title: grouped ? 'No project' : '', rooms: groups.rest },
          ].map((section) => (
            <Fragment key={section.key}>
              {section.rooms.length > 0 && section.title && (
                <div className="sec bold-room-group">{section.title}</div>
              )}
              {section.rooms.map((room) => (
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
                      {note(room) ? ` · ${note(room)}` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </Fragment>
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
                  {note(room) ? ` · ${note(room)}` : ''}
                </span>
              </span>
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={false}
            className="mi"
            onClick={() => {
              close(false)
              setMakingTeam(true)
            }}
          >
            <PlusIcon />
            <span className="menu-copy">
              <b>New team…</b>
              <span className="small muted">Pick the agents and a lead</span>
            </span>
          </button>
          {(archivedCount > 0 || showArchived) && (
            <button
              type="button"
              role="option"
              aria-selected={showArchived}
              className="mi"
              onClick={() => setShowArchived((value) => !value)}
            >
              <span className="menu-copy">
                <b>{showArchived ? 'Hide archived' : 'Show archived'}</b>
                <span className="small muted">
                  {archivedCount} archived {archivedCount === 1 ? 'room' : 'rooms'}
                </span>
              </span>
            </button>
          )}
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
      {makingTeam && (
        <NewTeamDialog
          onClose={() => {
            setMakingTeam(false)
            trigger.current?.focus()
          }}
          onCreated={(room) => {
            setMakingTeam(false)
            onSelectRoom(room)
          }}
        />
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

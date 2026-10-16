import { Link, useParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { AvatarMenu } from '../../shell/AvatarMenu.tsx'
import { ConversationSearch } from '../chat/ConversationSearch.tsx'
import { agentsQuery, roomsQuery } from '../chat/queries.ts'
import { RoomLink } from '../chat/RoomLink.tsx'
import { isRunOver } from '../orchestrations/orch-model.ts'
import { orchestrationsQuery } from '../orchestrations/orchestration-queries.ts'
import { userRoomPath } from './user-view.ts'

/** Rooms whose orchestration is still going: they get a small live dot. */
export function useLiveRooms(): ReadonlySet<string> {
  const runs = useStreamQuery(orchestrationsQuery).data
  return new Set((runs ?? []).filter((run) => !isRunOver(run.status)).map((run) => run.roomId))
}

export function UserSidebar() {
  const { roomId } = useParams<{ roomId: string }>()
  const rooms = useStreamQuery(roomsQuery)
  const agents = useStreamQuery(agentsQuery).data ?? []
  const live = useLiveRooms()
  const runRooms = new Set(
    (useStreamQuery(orchestrationsQuery).data ?? []).map((run) => run.roomId),
  )
  const base = userRoomPath('').replace(/\/$/, '')
  const all = [...(rooms.data?.rooms ?? []), ...(rooms.data?.directs ?? [])]
  return (
    <>
      <div className="user-brand">
        <svg
          className="brand-mark"
          width="30"
          height="30"
          viewBox="0 0 30 30"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="28" height="28" rx="9" />
          <path className="brand-violet" d="M7 10 H15" />
          <path className="brand-jade" d="M11 15 H23" />
          <path className="brand-saffron" d="M9 20 H18" />
        </svg>
        <span className="wordmark">score</span>
      </div>
      <Link className="user-new-chat" to="/u" state={{ fresh: true }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3 V13 M3 8 H13"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        New chat
      </Link>
      <ConversationSearch
        rooms={all}
        agents={agents}
        hrefFor={(room, message) => `${userRoomPath(room)}?message=${encodeURIComponent(message)}`}
      />
      <nav aria-label="Conversations" className="user-nav">
        {rooms.status === 'pending' && !rooms.data && <p role="status">Loading rooms…</p>}
        {rooms.status === 'error' && <p role="alert">Couldn’t load rooms.</p>}
        {rooms.data && (
          <>
            <div className="chat-room-group">
              <h2>Rooms</h2>
              {rooms.data.rooms
                .filter((room) => !room.archived)
                .map((room) => (
                  <RoomLink
                    key={room.id}
                    room={room}
                    selected={roomId}
                    agents={agents}
                    orchestration={runRooms.has(room.id)}
                    live={live.has(room.id)}
                    base={base}
                  />
                ))}
              {!rooms.data.rooms.length && <p className="chat-list-empty">No rooms yet.</p>}
            </div>
            <div className="chat-room-group">
              <h2>Agents</h2>
              {rooms.data.directs.map((room) => (
                <RoomLink
                  key={room.id}
                  room={room}
                  selected={roomId}
                  agents={agents}
                  live={live.has(room.id)}
                  base={base}
                />
              ))}
              {!rooms.data.directs.length && <p className="chat-list-empty">No agents yet.</p>}
            </div>
          </>
        )}
      </nav>
      <div className="user-sidebar-foot">
        <AvatarMenu view="user" placement="above" />
      </div>
    </>
  )
}

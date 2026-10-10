import type { Room } from '@score/contract'
import { useCallback, useContext, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ResponsiveDrawer } from '../../components/ResponsiveDrawer.tsx'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { ChatThread, QueryError } from './ChatThread.tsx'
import { RoomPanels } from './RoomPanels.tsx'
import { agentsQuery, roomsQuery } from './queries.ts'
import { ConversationSearch } from './ConversationSearch.tsx'
import { ShareDialog } from './ShareDialog.tsx'
import { OutsideSessions } from './OutsideSessions.tsx'
import { RoomLink } from './RoomLink.tsx'
import { RoomList } from './RoomList.tsx'
import { NewOrchestrationDialog } from '../orchestrations/NewOrchestrationDialog.tsx'
import { orchestrationsQuery } from '../orchestrations/orchestration-queries.ts'
import { workflowRunsQuery } from '../workflows/workflow-queries.ts'
import './chat.css'

export function ChatPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const rooms = useStreamQuery(roomsQuery)
  const agents = useStreamQuery(agentsQuery)
  const context = useContext(StreamContext)!
  const [sharing, setSharing] = useState<Room | null>(null)
  const [starting, setStarting] = useState(false)
  const navigate = useNavigate()
  const [listOpen, setListOpen] = useState(false)
  const closeList = useCallback(() => setListOpen(false), [])
  const orchestrationRoomList = useStreamQuery(orchestrationsQuery).data
  const workflowRoomList = useStreamQuery(workflowRunsQuery).data
  const workflowRooms = new Set((workflowRoomList ?? []).map((run) => run.roomId))
  const orchestrationRooms = new Set([
    ...(orchestrationRoomList ?? []).map((run) => run.roomId),
    ...workflowRooms,
  ])
  return (
    <div className="chat-layout">
      {roomId && (
        <button
          className="chat-list-toggle"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={listOpen}
          onClick={() => setListOpen(true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H9"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          Conversations
        </button>
      )}
      <ResponsiveDrawer
        label="Conversations"
        className="chat-conversations"
        open={listOpen}
        onClose={closeList}
        inline={!roomId}
      >
        <div className="chat-new-row">
          <button className="chat-new" type="button" disabled>
            ＋ New chat
          </button>
          <button
            className="chat-new chat-new--secondary"
            type="button"
            onClick={() => setStarting(true)}
          >
            ＋ New orchestration
          </button>
        </div>
        {rooms.status === 'pending' && !rooms.data && <p role="status">Loading conversations…</p>}
        {rooms.status === 'error' && (
          <QueryError
            text="Could not load conversations."
            retry={() => void context.queries.register(roomsQuery).refetch()}
          />
        )}
        {agents.status === 'error' && (
          <QueryError
            text="Could not load agents."
            retry={() => void context.queries.register(agentsQuery).refetch()}
          />
        )}
        <ConversationSearch
          rooms={[...(rooms.data?.rooms ?? []), ...(rooms.data?.directs ?? [])]}
          agents={agents.data ?? []}
        />
        <nav aria-label="Conversations">
          {rooms.data && (
            <RoomList
              rooms={rooms.data.rooms}
              projects={rooms.data.projects}
              selected={roomId}
              agents={agents.data ?? []}
              orchestrationRooms={orchestrationRooms}
              workflowRooms={workflowRooms}
              onShare={setSharing}
            />
          )}
          <div className="chat-room-group">
            <h2>Direct</h2>
            {rooms.data?.directs.map((room) => (
              <RoomLink key={room.id} room={room} selected={roomId} agents={agents.data ?? []} />
            ))}
            {rooms.data && !rooms.data.directs.length && (
              <p className="chat-list-empty">No direct conversations yet.</p>
            )}
          </div>
          <OutsideSessions agents={agents.data ?? []} />
        </nav>
      </ResponsiveDrawer>
      {roomId ? (
        <ChatThread key={`thread:${roomId}`} roomId={roomId} agents={agents.data ?? []} />
      ) : (
        <section className="chat-thread chat-welcome" aria-label="Conversation">
          <h1>Chat</h1>
          <p>Choose a conversation to see its messages.</p>
        </section>
      )}
      {roomId && <RoomPanels key={`panels:${roomId}`} roomId={roomId} agents={agents.data ?? []} />}
      {sharing && <ShareDialog room={sharing} close={() => setSharing(null)} />}
      {starting && (
        <NewOrchestrationDialog
          agents={agents.data ?? []}
          close={() => setStarting(false)}
          created={(run) => {
            setStarting(false)
            void navigate(`/chat/${encodeURIComponent(run.roomId)}`)
          }}
        />
      )}
    </div>
  )
}

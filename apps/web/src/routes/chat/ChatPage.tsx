import { useContext } from 'react'
import { useParams } from 'react-router'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { ChatThread, QueryError } from './ChatThread.tsx'
import { RoomPanels } from './RoomPanels.tsx'
import { agentsQuery, roomsQuery } from './queries.ts'
import { ConversationSearch } from './ConversationSearch.tsx'
import { RoomLink } from './RoomLink.tsx'
import { RoomList } from './RoomList.tsx'
import './chat.css'

export function ChatPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const rooms = useStreamQuery(roomsQuery)
  const agents = useStreamQuery(agentsQuery)
  const context = useContext(StreamContext)!
  return (
    <div className="chat-layout">
      <aside className="chat-conversations" aria-label="Conversations">
        <button className="chat-new" type="button" disabled>
          ＋ New chat
        </button>
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
        </nav>
      </aside>
      {roomId ? (
        <ChatThread key={`thread:${roomId}`} roomId={roomId} agents={agents.data ?? []} />
      ) : (
        <section className="chat-thread chat-welcome" aria-label="Conversation">
          <h1>Chat</h1>
          <p>Choose a conversation to see its messages.</p>
        </section>
      )}
      {roomId && <RoomPanels key={`panels:${roomId}`} roomId={roomId} agents={agents.data ?? []} />}
    </div>
  )
}

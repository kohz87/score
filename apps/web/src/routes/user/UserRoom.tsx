import { useEffect, useRef } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { ChatThread } from '../chat/ChatThread.tsx'
import { agentsQuery, roomsQuery } from '../chat/queries.ts'
import { saveLastRoom } from './user-view.ts'

/** `/u/rooms/:roomId`: one conversation, centred. */
export function UserRoom() {
  const { roomId } = useParams<{ roomId: string }>()
  const rooms = useStreamQuery(roomsQuery)
  const agents = useStreamQuery(agentsQuery).data ?? []
  const navigate = useNavigate()
  // A room that disappears from the list (deleted in the admin view or another tab) takes its page with it.
  const seen = useRef(new Set<string>())
  useEffect(() => {
    if (!rooms.data) return
    const listed = new Set([...rooms.data.rooms, ...rooms.data.directs].map((room) => room.id))
    if (roomId && seen.current.has(roomId) && !listed.has(roomId))
      void navigate('/u', { replace: true, state: { fresh: true } })
    listed.forEach((id) => seen.current.add(id))
  }, [rooms.data, roomId, navigate])
  useEffect(() => {
    if (roomId) saveLastRoom(roomId)
  }, [roomId])
  if (!roomId) return <Navigate to="/u" replace />
  return <ChatThread key={`thread:${roomId}`} roomId={roomId} agents={agents} variant="user" />
}

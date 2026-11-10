import type { Room } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomsQuery } from '../../routes/chat/queries.ts'
import { teamRoomsQuery } from '../room/room-queries.ts'

/** The chats a recipe's runs can start in: the team rooms and the group chats, not the archived ones. */
export function useRecipeChats(): Room[] {
  const rooms = useStreamQuery(roomsQuery).data?.rooms
  const teams = useStreamQuery(teamRoomsQuery).data
  return useMemo(
    () =>
      [...(teams ?? []), ...(rooms ?? [])].filter(
        (room, index, all) =>
          !room.archived && all.findIndex((other) => other.id === room.id) === index,
      ),
    [rooms, teams],
  )
}

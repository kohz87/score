import { expect, test } from 'vitest'
import type { Room, StreamEvent } from '@score/contract'
import { roomsQuery } from './queries.ts'

const room = (id: string, activeAgents: string[]): Room => ({
  id,
  name: `#${id}`,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents,
  channels: [],
})
const upserted = (data: Room) =>
  ({ type: 'room.upserted', id: '1', data }) as unknown as StreamEvent

// The sidebar's list is one query for all rooms: a room update changes its icons whichever room is open.
test('a room update starts and clears a member’s icon in the list, whatever room is selected', () => {
  const start = { rooms: [room('a', []), room('b', [])], directs: [], projects: [] }
  const busy = roomsQuery.reduce(start, upserted(room('b', ['builder'])))
  expect(busy.rooms.map((item) => [item.id, item.activeAgents])).toEqual([
    ['a', []],
    ['b', ['builder']],
  ])
  const done = roomsQuery.reduce(busy, upserted(room('b', [])))
  expect(done.rooms.map((item) => item.activeAgents)).toEqual([[], []])
})

import type { Room, StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { roomsQuery } from './queries.ts'

test('the classic Chat reducer ignores an upserted team room', () => {
  const team: Room = {
    id: 'team-room',
    name: 'Team room',
    kind: 'room',
    leadAgentId: null,
    members: ['lead', 'builder'],
    unread: 0,
    activeAgents: [],
    channels: [],
    role: 'team',
    routing: 'exchanges',
  }
  const data = { rooms: [], directs: [], projects: [] }
  const event: Extract<StreamEvent, { type: 'room.upserted' }> = {
    seq: 1,
    ts: '2026-10-24T14:00:00.000Z',
    type: 'room.upserted',
    data: team,
  }
  expect(roomsQuery.reduce(data, event)).toBe(data)
})

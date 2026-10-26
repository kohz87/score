import type { AgentSummary, Room, StreamEvent } from '@score/contract'
import { expect, test } from 'vitest'
import { agentsQuery, roomsQuery } from './queries.ts'

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

test('an updated agent keeps its place in the list; a new one joins at the end (3.5.0)', () => {
  const agent = (id: string, status: AgentSummary['status'] = 'idle'): AgentSummary => ({
    id,
    name: id,
    role: '',
    style: { color: '#19C39A', shape: 'triangle' },
    status,
    activity: null,
    model: null,
    served: true,
  })
  const data = [agent('lead'), agent('builder'), agent('reviewer')]
  const updated = { type: 'agent.updated', data: agent('builder', 'working') } as StreamEvent
  expect(agentsQuery.reduce(data, updated).map((item) => [item.id, item.status])).toEqual([
    ['lead', 'idle'],
    ['builder', 'working'],
    ['reviewer', 'idle'],
  ])
  const added = { type: 'agent.updated', data: agent('designer') } as StreamEvent
  expect(agentsQuery.reduce(data, added).map((item) => item.id)).toEqual([
    'lead',
    'builder',
    'reviewer',
    'designer',
  ])
})

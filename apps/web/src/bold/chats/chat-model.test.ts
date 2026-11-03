import type { AgentSummary, Job, Room } from '@score/contract'
import { expect, test } from 'vitest'
import {
  activityLabel,
  buildChatLists,
  chatAddress,
  chatIsOpen,
  filterEntries,
  isChatGroup,
} from './chat-model.ts'

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
const room = (id: string, extra: Partial<Room> = {}): Room => ({
  id,
  name: id,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
  routing: 'exchanges',
  ...extra,
})
const job = (id: string, roomId: string, updatedAt: string, extra: Partial<Job> = {}) =>
  ({
    id,
    roomId,
    title: id,
    state: 'working',
    isDefault: false,
    updatedAt,
    ...extra,
  }) as Job

test('only chats people talk in are groups: no hidden run room, imported session or archived room', () => {
  expect(isChatGroup(room('a'))).toBe(true)
  expect(isChatGroup(room('t', { role: 'team', everyone: true }))).toBe(true)
  expect(isChatGroup(room('run', { routing: 'mentions' }))).toBe(false)
  expect(isChatGroup(room('old', { archived: true }))).toBe(false)
  expect(
    isChatGroup(
      room('imp', {
        importedFrom: {
          agentId: 'lead',
          sessionId: 's',
          source: 'cli',
          label: 'x',
          continued: null,
        },
      }),
    ),
  ).toBe(false)
})

test('groups and directs are each ordered newest activity first and describe themselves from existing data', () => {
  const team = room('team', { role: 'team', everyone: true, name: 'Team room', unread: 2 })
  const feed = room('feed', { name: 'Feed crew' })
  const lists = buildChatLists({
    rooms: [feed, room('run', { routing: 'mentions' })],
    teamRooms: [team],
    directRooms: [
      room('d-lead', { kind: 'direct', members: ['lead'], unread: 3 }),
      room('d-builder', { kind: 'direct', members: ['builder'] }),
    ],
    agents: [agent('lead'), agent('builder', 'working'), agent('reviewer', 'waiting')],
    jobsByRoom: {
      team: [job('old job', 'team', '2026-11-01T10:00:00.000Z')],
      feed: [job('Socket', 'feed', '2026-11-03T10:00:00.000Z', { state: 'waiting_on_you' })],
      'd-builder': [job('chat', 'd-builder', '2026-11-02T10:00:00.000Z')],
    },
    approvals: [],
    questions: [],
  })
  expect(lists.groups.map((entry) => entry.name)).toEqual(['Feed crew', 'Team room'])
  expect(lists.groups[0]).toMatchObject({ line: 'Socket · needs you', needsYou: true })
  expect(lists.groups[1]).toMatchObject({ unread: 2, needsYou: false, everyone: true })
  expect(lists.directs.map((entry) => entry.name)).toEqual(['builder', 'lead', 'reviewer'])
  expect(lists.directs[0]).toMatchObject({ line: 'working' })
  expect(lists.directs[1]).toMatchObject({ unread: 3 })
  expect(lists.directs[2]).toMatchObject({ line: 'waiting for you', needsYou: true })
})

test('a room without jobs says how many members it has; the search filters by name', () => {
  const lists = buildChatLists({
    rooms: [room('solo', { members: ['lead'] }), room('Billing')],
    teamRooms: [],
    directRooms: [],
    agents: [],
    jobsByRoom: {},
    approvals: [],
    questions: [],
  })
  expect(lists.groups.find((entry) => entry.id === 'solo')?.line).toBe('1 member')
  expect(filterEntries(lists.groups, ' bill ').map((entry) => entry.name)).toEqual(['Billing'])
  expect(filterEntries(lists.groups, '')).toHaveLength(2)
})

test('chat addresses are the existing ones, and a phone `/b` with nothing open is the list', () => {
  expect(chatAddress({ kind: 'group', id: 't', everyone: true }, false)).toBe('/b')
  expect(chatAddress({ kind: 'group', id: 't', everyone: true }, true)).toBe('/b?open=1')
  expect(chatAddress({ kind: 'group', id: 'r 1', everyone: false }, false)).toBe('/b?room=r%201')
  expect(chatAddress({ kind: 'direct', id: 'builder', everyone: false }, true)).toBe(
    '/b?with=builder',
  )
  expect(chatIsOpen(new URLSearchParams(''))).toBe(false)
  expect(chatIsOpen(new URLSearchParams('start=job'))).toBe(false)
  expect(chatIsOpen(new URLSearchParams('job=j1'))).toBe(true)
  expect(chatIsOpen(new URLSearchParams('open=1'))).toBe(true)
})

test('the row time is the clock today, a weekday this week, else the date', () => {
  const now = new Date(2026, 10, 3, 15, 0)
  expect(activityLabel('', now)).toBe('')
  expect(activityLabel(new Date(2026, 10, 3, 9, 40).toISOString(), now)).toMatch(/^09[:.]40$/)
  expect(activityLabel(new Date(2026, 10, 1, 9, 40).toISOString(), now)).toMatch(/^\p{L}+\.?$/u)
  expect(activityLabel(new Date(2026, 9, 20, 9, 40).toISOString(), now)).toMatch(/\d/)
})

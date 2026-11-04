import type { AgentSummary, Job, Room } from '@score/contract'
import { expect, test } from 'vitest'
import {
  activityLabel,
  buildChatLists,
  chatAddress,
  chatForRun,
  runIdOf,
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

test('a run opens at the chat and topic whose job links to it, else nowhere (the Recipes page keeps it)', () => {
  const recipe = (ref: string) => ({ recipe: { kind: 'workflow' as const, ref } })
  const lists = buildChatLists({
    rooms: [room('feed')],
    teamRooms: [room('team', { role: 'team', name: 'Team room' })],
    directRooms: [room('d-lead', { kind: 'direct', members: ['lead'] })],
    agents: [agent('lead')],
    jobsByRoom: {
      team: [job('job-t', 'team', '2026-11-01T10:00:00.000Z', recipe('run-team'))],
      feed: [job('job-f', 'feed', '2026-11-01T10:00:00.000Z', recipe('run-feed'))],
      'd-lead': [job('job-d', 'd-lead', '2026-11-01T10:00:00.000Z', recipe('run-direct'))],
    },
    approvals: [],
    questions: [],
  })
  const jobs = {
    team: [job('job-t', 'team', '', recipe('run-team'))],
    feed: [job('job-f', 'feed', '', recipe('run-feed'))],
    'd-lead': [job('job-d', 'd-lead', '', recipe('run-direct'))],
  } as Record<string, Job[]>
  expect(chatForRun(lists, jobs, 'run-team')).toBe('/b?job=job-t')
  expect(chatForRun(lists, jobs, 'run-feed')).toBe('/b?room=feed&job=job-f')
  expect(chatForRun(lists, jobs, 'run-direct')).toBe('/b?with=lead&chat=job-d')
  expect(chatForRun(lists, jobs, 'run-unknown')).toBeNull()
})

test('the current topic is the picked one, else the newest open one, else the general conversation', async () => {
  const { currentTopic } = await import('./chat-model.ts')
  const make = (id: string, isDefault: boolean, state: string, createdAt: string): Job =>
    ({ id, isDefault, state, createdAt }) as unknown as Job
  const jobs = [
    make('general', true, 'working', '2026-01-01'),
    make('old', false, 'working', '2026-01-02'),
    make('new', false, 'working', '2026-01-03'),
    make('done', false, 'done', '2026-01-04'),
  ]
  expect(currentTopic(jobs, null)?.id).toBe('new')
  expect(currentTopic(jobs, 'done')?.id).toBe('done')
  expect(currentTopic(jobs.slice(0, 1), null)?.id).toBe('general')
})

test('3.29.0 gate: a run link names the run by its brief; the chat job by the run’s own id', () => {
  const runs = [
    { id: 'orc-1', briefId: 'orc-goal:orc-1' },
    { id: 'wfr-1', briefId: 'brief-wfrun-1' },
  ]
  expect(runIdOf('orc-goal:orc-1', runs)).toBe('orc-1')
  expect(runIdOf('brief-wfrun-1', runs)).toBe('wfr-1')
  expect(runIdOf('orc-1', runs)).toBe('orc-1')
  expect(runIdOf('unknown', runs)).toBe('unknown')
})

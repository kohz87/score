import type { AgentSummary, Job, MessageSearchHit } from '@score/contract'
import { expect, test } from 'vitest'
import {
  buildBoldSearchGroups,
  flattenBoldSearch,
  nextBoldSearchIndex,
  RESULT_LIMIT,
  type BoldSearchInput,
} from './bold-search-model.ts'

const agent = (id: string, role = ''): AgentSummary => ({
  id,
  name: id,
  role,
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})

const job = (id: string, title: string, extra: Partial<Job> = {}): Job => ({
  id,
  roomId: 'team',
  title,
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  ...extra,
})

const message = (extra: Partial<MessageSearchHit> = {}): MessageSearchHit => ({
  messageId: 'm1',
  roomId: 'team',
  roomName: 'Team room',
  jobId: 'j1',
  author: { kind: 'agent', agentId: 'builder' },
  createdAt: '2026-10-24T10:00:00.000Z',
  snippet: 'The [[cursor]] and loading states look good.',
  ...extra,
})

const input = (overrides: Partial<BoldSearchInput> = {}): BoldSearchInput => ({
  query: '',
  agents: [agent('lead', 'Leads'), agent('builder', 'Builds')],
  teamJobs: [job('j1', 'Activity feed', { unread: 2 })],
  roomName: 'Team room',
  directChats: [
    {
      agentId: 'builder',
      chats: [job('c1', 'The cursor bug', { summary: 'Why the cursor jumps' })],
    },
  ],
  notes: [
    { path: 'Projects/Roadmap.md', title: 'Event cursors', lastAuthor: { agentId: 'reviewer' } },
  ],
  messages: [message()],
  commands: [
    { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
    { name: 'model', usage: '/model <model> <message>', description: 'Use a model.' },
  ],
  paused: false,
  light: false,
  settings: [{ id: 'look', title: 'Look' }],
  ...overrides,
})

test('groups jobs, one-to-ones, Library and actions in the prototype order', () => {
  const groups = buildBoldSearchGroups(input())
  expect(groups.map((group) => group.label)).toEqual([
    'Jobs',
    'One-to-one chats',
    'Library',
    'Do something',
  ])
  expect(groups[0]?.items[0]).toMatchObject({
    kind: 'job',
    title: 'Activity feed',
    hint: 'Team room · working',
    unread: 2,
  })
  expect(groups[1]?.items[0]).toMatchObject({
    kind: 'chat',
    title: 'The cursor bug',
    hint: 'with builder · Why the cursor jumps',
  })
  expect(groups[3]?.items.map((item) => item.title)).toContain('Reset look on this device')
  expect(groups[3]?.items.map((item) => item.title)).toContain('Settings: Look')
})

test('a query adds messages in the Messages group and keeps them with their job', () => {
  const groups = buildBoldSearchGroups(
    input({ query: 'cursor', teamJobs: [job('j1', 'Cursor activity feed')] }),
  )
  expect(groups.map((group) => group.key)).toEqual(['jobs', 'chats', 'notes', 'messages'])
  expect(groups.at(-1)?.items[0]).toMatchObject({
    kind: 'message',
    title: '“The cursor and loading states look good.”',
    hint: 'builder · Cursor activity feed',
    jobId: 'j1',
    messageId: 'm1',
  })
})

test('multi-word message and note hits survive their marked server snippets', () => {
  const groups = buildBoldSearchGroups(
    input({
      query: 'cursor loading',
      notes: [
        {
          path: 'Projects/Roadmap.md',
          title: 'Release rollup',
          snippet: 'The [[cursor]] and [[loading]] states are approved.',
        },
      ],
      messages: [message({ snippet: 'The [[cursor]] and [[loading]] states look good.' })],
    }),
  )

  expect(groups.find((group) => group.key === 'notes')?.items[0]).toMatchObject({
    kind: 'note',
    title: 'Release rollup',
    hint: 'Projects · The cursor and loading states are approved.',
  })
  expect(groups.find((group) => group.key === 'messages')?.items[0]).toMatchObject({
    kind: 'message',
    title: '“The cursor and loading states look good.”',
    jobId: 'j1',
  })
})

test('a message in a one-to-one chat carries the chat owner for its link', () => {
  const groups = buildBoldSearchGroups(
    input({
      query: 'cursor',
      messages: [message({ jobId: 'c1' })],
    }),
  )
  expect(groups.find((group) => group.key === 'messages')?.items[0]).toMatchObject({
    kind: 'message',
    jobId: 'c1',
    chatAgentId: 'builder',
  })
})

test('the empty query keeps the Library and actions, but not message hits', () => {
  const groups = buildBoldSearchGroups(input())
  expect(groups.some((group) => group.key === 'messages')).toBe(false)
  expect(groups.some((group) => group.key === 'notes')).toBe(true)
  expect(groups.at(-1)?.items.map((item) => item.title)).toEqual(
    expect.arrayContaining(['Start a job', 'Pause everyone', 'Switch to light']),
  )
})

test('an unknown pause state disables Pause everyone with the read failure hint', () => {
  const groups = buildBoldSearchGroups(input({ paused: null, query: 'Pause everyone' }))
  const pause = groups
    .flatMap((group) => group.items)
    .find((result) => result.kind === 'action' && result.action.type === 'pause')
  expect(pause).toMatchObject({
    title: 'Pause everyone',
    hint: "Couldn't read whether the team is paused",
    disabled: true,
  })
})

test('switching the look is labelled as a visit-only choice', () => {
  const groups = buildBoldSearchGroups(input({ query: 'Switch to light' }))
  const look = groups
    .flatMap((group) => group.items)
    .find((result) => result.kind === 'action' && result.action.type === 'toggle-look')
  expect(look).toMatchObject({ title: 'Switch to light', hint: 'for this visit' })
})

test('slash mode lists commands only, and at mode lists people only', () => {
  const commands = buildBoldSearchGroups(input({ query: '/as' }))
  expect(commands).toEqual([
    {
      key: 'commands',
      label: 'Commands',
      items: [
        expect.objectContaining({
          kind: 'command',
          title: '/assign',
          name: 'assign',
        }),
      ],
    },
  ])

  const people = buildBoldSearchGroups(input({ query: '@bui' }))
  expect(people[0]?.items).toEqual([
    expect.objectContaining({
      kind: 'action',
      title: 'Message builder',
      action: { type: 'message-agent', agentId: 'builder' },
    }),
  ])
})

test('nothing matches stays empty and the list is capped at the prototype limit', () => {
  expect(buildBoldSearchGroups(input({ query: 'zzzz', notes: [], messages: [] }))).toEqual([])
  const many = Array.from({ length: RESULT_LIMIT + 4 }, (_, index) =>
    job(`j${index}`, `Queue ${index}`),
  )
  const groups = buildBoldSearchGroups(input({ teamJobs: many, query: 'Queue' }))
  expect(flattenBoldSearch(groups)).toHaveLength(RESULT_LIMIT)
})

test('arrow selection wraps in both directions', () => {
  expect(nextBoldSearchIndex(-1, 1, 3)).toBe(0)
  expect(nextBoldSearchIndex(-1, -1, 3)).toBe(2)
  expect(nextBoldSearchIndex(2, 1, 3)).toBe(0)
  expect(nextBoldSearchIndex(0, -1, 3)).toBe(2)
  expect(nextBoldSearchIndex(0, 1, 0)).toBe(-1)
})

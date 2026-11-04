import { QueryClient } from '@tanstack/react-query'
import type { AgentSummary, Room } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { roomJobsQuery } from './room-queries.ts'
import { agents, makeJob, room } from './room-test-utils.tsx'
import {
  runTopicCommand,
  TOPIC_COMMANDS,
  TYPED_ONLY_COMMANDS,
  type TopicCommandContext,
} from './topic-commands.ts'

type Call = { path: string; method: string; body: unknown }
let calls: Call[]
let queryClient: QueryClient
let said: string[]
let picked: (string | null)[]
let respond: (call: Call) => unknown

beforeEach(() => {
  calls = []
  queryClient = new QueryClient()
  said = []
  picked = []
  respond = () => ({})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      calls.push(call)
      return Response.json(respond(call))
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const feed = makeJob({ id: 'job-feed', title: 'Activity feed', state: 'working' })
const general = makeJob({ id: 'job-general', title: 'General', isDefault: true, state: 'open' })

const members = ['lead', 'builder']
const chat: Room = { ...room, members, leadAgentId: 'lead' }
const roster: AgentSummary[] = agents

function context(over: Partial<TopicCommandContext> = {}): TopicCommandContext {
  return {
    room: chat,
    agents: roster,
    jobs: [general, feed],
    current: feed,
    workspaces: [{ id: 'ws-1', name: 'Docs' }],
    queryClient,
    pick: (jobId) => picked.push(jobId),
    say: (text) => said.push(text),
    ...over,
  }
}

const run = (name: string, args: string, over: Partial<TopicCommandContext> = {}) =>
  runTopicCommand(name, args, context(over))

test('the palette lists every chat command with a usage line and a description', () => {
  expect(TOPIC_COMMANDS.map((item) => item.name)).toEqual([
    'rename',
    'done',
    'reopen',
    'lead',
    'add',
    'remove',
    'run',
    'workspace',
  ])
  for (const item of TOPIC_COMMANDS) {
    expect(item.usage.startsWith(`/${item.name}`)).toBe(true)
    expect(item.description.length).toBeGreaterThan(5)
  }
})

test('/new is not in the palette; typed, it says a chat does one job at a time and sends nothing', async () => {
  expect(TOPIC_COMMANDS.map((item) => item.name)).not.toContain('new')
  expect(TYPED_ONLY_COMMANDS).toContain('new')
  await expect(run('new', '  Fix login ')).rejects.toThrow(
    'A chat does one job at a time: start one with /run, or Stop the current job first.',
  )
  await expect(run('new', '')).rejects.toThrow('A chat does one job at a time')
  expect(calls).toHaveLength(0)
  expect(picked).toEqual([])
  expect(said).toEqual([])
})

test('/reopen puts the reopened job in the cached job list before it is picked, so a send posts to it', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  respond = () => ({ ...closed, state: 'open' })
  queryClient.setQueryData(roomJobsQuery(room.id).key, { asOfSeq: 1, data: [general, closed] })
  let cachedState: string | undefined
  await run('reopen', '', {
    current: closed,
    jobs: [general, closed],
    pick: (jobId) => {
      picked.push(jobId)
      cachedState = (
        queryClient.getQueryData(roomJobsQuery(room.id).key) as {
          data: { id: string; state: string }[]
        }
      ).data.find((job) => job.id === 'job-closed')?.state
    },
  })
  expect(picked).toEqual(['job-closed'])
  expect(cachedState).toBe('open')
})

test('/rename renames the current job', async () => {
  respond = () => makeJob({ id: 'job-feed', title: 'Live feed' })
  await run('rename', 'Live feed')
  expect(calls[0]).toMatchObject({
    path: '/api/jobs/job-feed',
    method: 'PATCH',
    body: { title: 'Live feed' },
  })
  expect(said).toEqual(['You renamed the job “Activity feed” to “Live feed”'])
})

test('/rename needs an open job and a title', async () => {
  await expect(run('rename', 'x', { current: general })).rejects.toThrow(
    'There is no open job to rename. Start one with /run.',
  )
  await expect(run('rename', '')).rejects.toThrow('Give the new title: /rename <title>')
  expect(calls).toHaveLength(0)
})

test('/done closes the current job and leaves the choice to the newest open one', async () => {
  respond = () => makeJob({ id: 'job-feed', title: 'Activity feed', state: 'closed' })
  await run('done', '')
  expect(calls[0]).toMatchObject({ path: '/api/jobs/job-feed/close', method: 'POST' })
  expect(picked).toEqual([null])
  expect(said).toEqual(['You closed the job “Activity feed”'])
  await expect(run('done', '', { current: general })).rejects.toThrow(
    'There is no open job to close.',
  )
})

test('/reopen reopens the current finished job, else the latest finished one', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  respond = () => ({ ...closed, state: 'open' })
  await run('reopen', '', { current: closed, jobs: [general, feed, closed] })
  expect(calls[0]).toMatchObject({ path: '/api/jobs/job-closed/reopen', method: 'POST' })
  expect(picked).toEqual(['job-closed'])
  expect(said).toEqual(['You reopened the job “Old import”'])

  calls.length = 0
  const older = makeJob({
    id: 'job-done',
    title: 'Release notes',
    state: 'done',
    updatedAt: '2026-10-20T09:00:00.000Z',
  })
  const newer = makeJob({
    id: 'job-done-2',
    title: 'Queue research',
    state: 'done',
    updatedAt: '2026-10-22T09:00:00.000Z',
  })
  respond = () => ({ ...newer, state: 'open' })
  await run('reopen', '', { jobs: [general, feed, older, newer] })
  expect(calls[0]!.path).toBe('/api/jobs/job-done-2/reopen')

  await expect(run('reopen', '', { jobs: [general, feed] })).rejects.toThrow(
    'No finished job to reopen.',
  )
})

test('/lead, /add and /remove change the members through the room route and say what changed', async () => {
  respond = () => ({ ...chat })
  await run('lead', '@builder')
  expect(calls[0]).toMatchObject({
    path: '/api/rooms/room-1',
    method: 'PATCH',
    body: { leadAgentId: 'builder' },
  })
  expect(said.at(-1)).toBe('You made builder the owner')

  await run('add', '@reviewer')
  expect(calls[1]!.body).toEqual({ members: ['lead', 'builder', 'reviewer'] })
  expect(said.at(-1)).toBe('You added reviewer')

  await run('remove', 'builder')
  expect(calls[2]!.body).toEqual({ members: ['lead'] })
  expect(said.at(-1)).toBe('You took builder out')
})

test('/lead, /add and /remove explain what cannot be done and send nothing', async () => {
  await expect(run('lead', '')).rejects.toThrow('Say who: /lead @agent')
  await expect(run('add', '@nobody')).rejects.toThrow('There is no agent called @nobody')
  await expect(run('lead', '@reviewer')).rejects.toThrow('reviewer isn’t in this chat')
  await expect(run('add', '@builder')).rejects.toThrow('builder is already in this chat')
  await expect(run('remove', '@reviewer')).rejects.toThrow('reviewer isn’t in this chat')
  await expect(run('remove', '@lead')).rejects.toThrow('lead is the owner')
  expect(calls).toHaveLength(0)
})

test('/remove refuses the last member, and /add and /lead skip agents that cannot take messages', async () => {
  const solo: Room = { ...chat, members: ['builder'], leadAgentId: 'lead' }
  await expect(run('remove', '@builder', { room: solo })).rejects.toThrow('only one in this chat')
  const setup: AgentSummary[] = roster.map((agent) =>
    agent.id === 'reviewer'
      ? ({ ...agent, lifecycle: { state: 'setting-up' } } as unknown as AgentSummary)
      : agent,
  )
  await expect(run('add', '@reviewer', { agents: setup })).rejects.toThrow('can’t take messages')
  const inRoom: Room = { ...chat, members: ['lead', 'builder', 'reviewer'] }
  await expect(run('lead', '@reviewer', { agents: setup, room: inRoom })).rejects.toThrow(
    'can’t take messages',
  )
  expect(calls).toHaveLength(0)
})

test('/workspace sets the chat’s workspace by name, and none clears it', async () => {
  respond = () => ({ ...chat })
  await run('workspace', 'docs')
  expect(calls[0]).toMatchObject({
    path: '/api/rooms/room-1/workspace',
    method: 'PUT',
    body: { workspaceId: 'ws-1' },
  })
  expect(said.at(-1)).toBe('You set the workspace to Docs')

  await run('workspace', 'none')
  expect(calls[1]!.body).toEqual({ workspaceId: null })
  expect(said.at(-1)).toBe('You cleared the chat’s workspace')

  await expect(run('workspace', 'Slides')).rejects.toThrow(
    'No workspace called “Slides”. Yours: Docs.',
  )
  await expect(run('workspace', 'Slides', { workspaces: [] })).rejects.toThrow(
    'You have no workspaces yet.',
  )
  await expect(run('workspace', '')).rejects.toThrow('Name the workspace')
  expect(calls).toHaveLength(2)
})

test('a failing route comes back as the server’s words, and nothing is announced', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'conflict', message: 'That topic is busy.' } },
        { status: 409 },
      ),
    ),
  )
  await expect(run('done', '')).rejects.toThrow('That topic is busy.')
  expect(said).toEqual([])
  expect(picked).toEqual([])
})

test('/run opens Start a job for this chat, with the recipe name when one is typed', async () => {
  const opened: unknown[] = []
  await run('run', '', { startRun: (options) => opened.push(options) })
  await run('run', '  Release notes ', { startRun: (options) => opened.push(options) })
  expect(opened).toEqual([{ roomId: chat.id }, { roomId: chat.id, recipeName: 'Release notes' }])
  expect(calls).toEqual([])
})

test('/run with a job already running asks first (the busy dialog) and does not open Start a job', async () => {
  const opened: unknown[] = []
  const busy: unknown[] = []
  await run('run', ' Release notes ', {
    startRun: (options) => opened.push(options),
    onBusy: (info, options) => busy.push({ info, options }),
  })
  expect(opened).toEqual([])
  expect(busy).toEqual([
    {
      info: {
        running: { id: 'job-feed', title: 'Activity feed' },
        chatName: 'Team room',
        starting: 'run “Release notes”',
      },
      options: { roomId: chat.id, recipeName: 'Release notes' },
    },
  ])
  // Nothing running: it starts as before.
  await run('run', '', {
    jobs: [general],
    startRun: (options) => opened.push(options),
    onBusy: (info) => busy.push(info),
  })
  expect(opened).toEqual([{ roomId: chat.id }])
  expect(busy).toHaveLength(1)
})

test('/run in a direct chat says runs start in a group chat', async () => {
  const opened: unknown[] = []
  await expect(
    run('run', '', { room: { ...chat, kind: 'direct' }, startRun: (o) => opened.push(o) }),
  ).rejects.toThrow('Runs start in a group chat.')
  expect(opened).toEqual([])
})

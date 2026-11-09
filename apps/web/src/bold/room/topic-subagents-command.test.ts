import { QueryClient } from '@tanstack/react-query'
import type { AgentSummary, JobSubagents, Room } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { agents, makeJob, room } from './room-test-utils.tsx'
import { runTopicCommand, type TopicCommandContext } from './topic-commands.ts'

/** `/subagents` (SA.3 part 5): the composer answers it itself; it sets the job's limits and says so in the room. */
type Call = { path: string; method: string; body: unknown }
let calls: Call[]
let queryClient: QueryClient
let said: string[]
let ceiling: { control: 'limits' | 'on_off' | 'none'; maxConcurrent: number }

beforeEach(() => {
  calls = []
  said = []
  queryClient = new QueryClient()
  ceiling = { control: 'limits', maxConcurrent: 4 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        path: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      }
      calls.push(call)
      if (call.path.includes('/agents/lead/subagents'))
        return Response.json({
          agentId: 'lead',
          enabled: true,
          model: null,
          maxIterations: 50,
          timeoutSeconds: null,
          ...ceiling,
        })
      return Response.json(feed)
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const members = ['lead', 'builder']
const chat: Room = { ...room, members, leadAgentId: 'lead' }
const roster: AgentSummary[] = agents
const limits = (over: Partial<JobSubagents> = {}): JobSubagents => ({
  enabled: true,
  maxConcurrent: 2,
  maxTotal: 20,
  used: 3,
  ...over,
})
const feed = makeJob({
  id: 'job-feed',
  title: 'Activity feed',
  state: 'working',
  holderAgentId: 'lead',
  subagents: limits(),
})
const general = makeJob({ id: 'job-general', title: 'General', isDefault: true, state: 'open' })

function context(over: Partial<TopicCommandContext> = {}): TopicCommandContext {
  return {
    room: chat,
    agents: roster,
    jobs: [feed],
    current: feed,
    workspaces: [],
    queryClient,
    pick: () => undefined,
    say: (text) => said.push(text),
    ...over,
  }
}

const puts = () => calls.filter((call) => call.method === 'PUT')

test('the bare command shows the job’s state, with its use', async () => {
  await runTopicCommand('subagents', '', context())
  expect(said).toEqual(['Subagents are set to at most 2 for this job (3 of 20 used in this job).'])
  expect(puts()).toEqual([])
})

test('/subagents off sends enabled false for the current job and says so', async () => {
  await runTopicCommand('subagents', 'off', context())
  expect(puts()).toEqual([
    {
      path: expect.stringContaining('/jobs/job-feed/subagents'),
      method: 'PUT',
      body: { enabled: false },
    },
  ])
  expect(said).toEqual(['Subagents are off for this job.'])
})

test('/subagents on sends the agent’s limit (maxConcurrent null) and says so', async () => {
  await runTopicCommand('subagents', 'on', context())
  expect(puts()[0]?.body).toEqual({ enabled: true, maxConcurrent: null })
  expect(said).toEqual(['Subagents are on, up to the agent’s limit (4).'])
})

test('/subagents 2 sends a lower count, and the note confirms it', async () => {
  await runTopicCommand('subagents', '2', context())
  expect(puts()[0]?.body).toEqual({ enabled: true, maxConcurrent: 2 })
  expect(said).toEqual(['Subagents set to at most 2 for this job.'])
})

test('a number above the agent’s limit sends nothing and says the limit is lower', async () => {
  await runTopicCommand('subagents', '9', context())
  expect(puts()).toEqual([])
  expect(said).toEqual([
    'The agent’s limit is 4, so that’s the most you can set here. Nothing was sent.',
  ])
})

test('no current job: the note says to start one, and nothing is sent', async () => {
  await runTopicCommand('subagents', '2', context({ current: general }))
  expect(puts()).toEqual([])
  expect(said).toEqual(['There’s no job to set subagents for. Start one first.'])
})

test('an invalid argument gives the usage, and nothing is sent', async () => {
  await runTopicCommand('subagents', 'banana', context())
  expect(puts()).toEqual([])
  expect(said).toEqual(['Use /subagents off, /subagents on, or /subagents 2.'])
})

test('a Claude Code agent takes on or off, not a count', async () => {
  ceiling = { control: 'on_off', maxConcurrent: 4 }
  await runTopicCommand('subagents', '2', context())
  expect(puts()).toEqual([])
  expect(said[0]).toContain('decides how many run at once')
})

import { screen } from '@testing-library/react'
import type { Job, SubagentRow } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, makeJob, renderInRoom } from '../room/room-test-utils.tsx'
import { SubagentsInfo } from './SubagentsInfo.tsx'

/** SA.3 part 7: the side panel's SUBAGENTS section: at once, used in this job, their cost so far. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const row = (over: Partial<SubagentRow>): SubagentRow => ({
  id: 'sub',
  jobId: 'job-feed',
  agentId: 'lead',
  goal: 'Read the feed code',
  state: 'done',
  waitingOnYou: false,
  startedAt: '2026-11-09T01:00:00.000Z',
  endedAt: '2026-11-09T01:02:00.000Z',
  costUsd: null,
  tokens: null,
  ...over,
})

function stub(items: SubagentRow[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/agents/lead/subagents'))
        return jsonResponse({
          agentId: 'lead',
          control: 'limits',
          enabled: true,
          maxConcurrent: 4,
          model: null,
          maxIterations: 50,
          timeoutSeconds: null,
        })
      return jsonResponse({ asOfSeq: 1, items })
    }),
  )
}

const withLimits = (over: Partial<Job['subagents']> = {}): Job =>
  makeJob({
    id: 'job-feed',
    holderAgentId: 'lead',
    subagents: { enabled: true, maxConcurrent: null, maxTotal: 20, used: 4, ...over },
  })

test('shows at once, the used count, and the cost as about dollars when known', async () => {
  stub([row({ id: 'a', costUsd: 0.2 }), row({ id: 'b', costUsd: 0.22 })])
  renderInRoom(<SubagentsInfo job={withLimits()} watchAgentId="lead" agentName="lead" />)
  expect((await screen.findAllByText('up to 4')).length).toBeGreaterThan(0)
  expect(screen.getByText('4 of 20')).toBeTruthy()
  expect(await screen.findByText('about $0.42')).toBeTruthy()
  expect(screen.getByRole('link', { name: /See what lead’s subagents did in Watch/ })).toBeTruthy()
})

test('unknown cost is a dash, never $0', async () => {
  stub([row({ id: 'a', costUsd: null, tokens: null })])
  renderInRoom(<SubagentsInfo job={withLimits()} watchAgentId="lead" agentName="lead" />)
  expect(await screen.findByText('—')).toBeTruthy()
  expect(screen.queryByText(/\$0/)).toBeNull()
})

test('a route with only tokens shows the tokens', async () => {
  stub([row({ id: 'a', costUsd: null, tokens: 2400 })])
  renderInRoom(<SubagentsInfo job={withLimits()} watchAgentId="lead" agentName="lead" />)
  expect(await screen.findByText('2,400 tokens')).toBeTruthy()
})

test('a job without subagent limits shows no section', () => {
  stub([])
  const { container } = renderInRoom(
    <SubagentsInfo job={makeJob({ id: 'job-feed' })} watchAgentId="lead" agentName="lead" />,
  )
  expect(container.textContent).toBe('')
})

import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { AgentSubagents, Job, JobSubagents } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { disposeRoomTest, jsonResponse, makeJob, renderInRoom } from '../room/room-test-utils.tsx'
import { SubagentControl } from './SubagentControl.tsx'

/** SA.3 part 6: the context bar's subagent button, opening the same choices as `/subagents`. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const limits = (over: Partial<JobSubagents> = {}): JobSubagents => ({
  enabled: true,
  maxConcurrent: null,
  maxTotal: 20,
  used: 0,
  ...over,
})

const ceiling = (over: Partial<AgentSubagents> = {}): AgentSubagents => ({
  agentId: 'lead',
  control: 'limits',
  enabled: true,
  maxConcurrent: 4,
  model: null,
  maxIterations: 50,
  timeoutSeconds: null,
  ...over,
})

function stub(agent: AgentSubagents) {
  const calls: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (path.includes('/agents/lead/subagents')) return jsonResponse(agent)
      return jsonResponse(makeJob({ id: 'job-feed', subagents: limits() }))
    }),
  )
  return calls
}

const job = (subagents: JobSubagents | undefined): Job =>
  makeJob({ id: 'job-feed', holderAgentId: 'lead', subagents })

test('no button when the job has no subagent limits', () => {
  stub(ceiling())
  renderInRoom(<SubagentControl job={job(undefined)} agentId="lead" />)
  expect(screen.queryByRole('button', { name: /Subagents:/ })).toBeNull()
})

test('a Codex agent (control none) gets no button', async () => {
  stub(ceiling({ control: 'none', maxConcurrent: 1 }))
  renderInRoom(<SubagentControl job={job(limits())} agentId="lead" />)
  await waitFor(() => expect(screen.queryByRole('button', { name: /Subagents:/ })).toBeNull())
})

test('the button names the agent’s limit, and the menu offers off, each count and the agent’s own limit', async () => {
  stub(ceiling())
  renderInRoom(<SubagentControl job={job(limits())} agentId="lead" />)
  const button = await screen.findByRole('button', { name: 'Subagents: up to 4' })
  fireEvent.click(button)
  const items = screen.getAllByRole('menuitemradio')
  // Each item's text is its label followed by its small note.
  expect(items.map((item) => item.textContent)).toEqual([
    'OffNone in this job',
    'At most 1 at once1 at once in this job',
    'At most 2 at once2 at once in this job',
    'At most 3 at once3 at once in this job',
    'At most 4 at once4 at once in this job',
    'Back to the agent’s limit (4)The agent’s own setting',
  ])
})

test('a Claude Code agent gets off and its own choice only, never a count', async () => {
  stub(ceiling({ control: 'on_off' }))
  renderInRoom(<SubagentControl job={job(limits())} agentId="lead" />)
  const button = await screen.findByRole('button', { name: 'Subagents: on' })
  fireEvent.click(button)
  const labels = screen.getAllByRole('menuitemradio').map((item) => item.textContent ?? '')
  expect(labels.some((text) => text.startsWith('At most'))).toBe(false)
  expect(labels).toHaveLength(2)
})

test('a chosen count is sent for this job as enabled with that maxConcurrent', async () => {
  const calls = stub(ceiling())
  renderInRoom(<SubagentControl job={job(limits())} agentId="lead" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Subagents: up to 4' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /At most 2 at once/ }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true))
  const put = calls.find((call) => call.method === 'PUT')
  expect(put?.path).toContain('/jobs/job-feed/subagents')
  expect(put?.body).toEqual({ enabled: true, maxConcurrent: 2 })
})

test('off shows as off, with no count to choose from', async () => {
  stub(ceiling())
  renderInRoom(<SubagentControl job={job(limits({ enabled: false }))} agentId="lead" />)
  expect(await screen.findByRole('button', { name: 'Subagents: off' })).toBeTruthy()
})

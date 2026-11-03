import type { AgentSummary, OrchestrationSummary } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  disposeRoomTest,
  jsonResponse,
  makeExchange,
  makeJob,
  makeTask,
  mockFetch,
  renderInRoom,
} from '../room/room-test-utils.tsx'
import { resetReportBackStore } from '../room/report-back-store.ts'
import { TopicInfo } from './TopicInfo.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
  resetReportBackStore()
})

const agents = [
  {
    id: 'builder',
    name: 'builder',
    role: '',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: { id: 'm', label: 'Demo' },
    served: true,
  },
] as AgentSummary[]

const orchestration: OrchestrationSummary = {
  id: 'orch-activity',
  title: 'Activity feed',
  status: 'running',
  pauseReason: null,
  leadAgentId: 'lead',
  roomId: 'room-1',
  briefId: 'brief-activity',
  gatePolicy: 'lead-asks',
  revision: 1,
  ownership: 'owned',
  steps: { total: 4, active: 1, succeeded: 2, failed: 0 },
  leadTurnsUsed: 1,
  maxLeadTurns: 8,
  needsYou: [],
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  endedAt: null,
}

const task = makeTask({ title: 'Write the migration', column: 'working', hermesStatus: 'running' })

function stub(options: {
  exchanges?: ReturnType<typeof makeExchange>[]
  orchestrations?: OrchestrationSummary[]
  jobs?: unknown[]
}) {
  const fetchMock = mockFetch((url, init) => {
    if (url === '/api/jobs/job-1/exchanges')
      return jsonResponse({ asOfSeq: 1, items: options.exchanges ?? [] })
    if (url === '/api/orchestrations')
      return jsonResponse({ asOfSeq: 1, items: options.orchestrations ?? [] })
    if (url === '/api/workflow-runs') return jsonResponse({ asOfSeq: 1, items: [] })
    if (url.startsWith('/api/rooms/room-1/jobs'))
      return jsonResponse({ asOfSeq: 1, items: options.jobs ?? [] })
    if (url.startsWith('/api/tasks?'))
      return jsonResponse({
        asOfSeq: 1,
        columns: { planned: [], working: [task], in_review: [], needs_you: [], done: [] },
      })
    if (url === '/api/jobs/job-1/stop' && init.method === 'POST') return jsonResponse({})
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('This topic shows the title, the protected status pill with round and turns, and the Hermes tasks', async () => {
  stub({ exchanges: [makeExchange()] })
  renderInRoom(<TopicInfo roomId="room-1" job={makeJob()} agents={agents} />)
  expect(screen.getByRole('heading', { name: 'This topic' })).toBeTruthy()
  expect(screen.getByText('Activity feed')).toBeTruthy()
  const pill = await screen.findByText('Needs you')
  expect(pill.getAttribute('data-protected')).toBe('inline')
  expect(pill.className).toContain('orch-pill')
  expect(pill.parentElement?.textContent).toContain('round 1 · needs your call · 8 of 8 turns used')
  expect(await screen.findByText('Write the migration')).toBeTruthy()
})

test('a job-limit pause names the job limit in the status', async () => {
  stub({
    exchanges: [makeExchange({ pause: { reason: 'job_limit', options: ['more_turns', 'stop'] } })],
  })
  renderInRoom(<TopicInfo roomId="room-1" job={makeJob()} agents={agents} />)
  expect(await screen.findByText(/Job turn limit reached \(40\)/)).toBeTruthy()
})

test('a recipe job shows its run with the step count and Open the run', async () => {
  stub({ orchestrations: [orchestration] })
  const job = makeJob({ recipe: { kind: 'orchestration', ref: 'orch-activity' } })
  renderInRoom(<TopicInfo roomId="room-1" job={job} agents={agents} />)
  expect(await screen.findByText('2 of 4 steps done')).toBeTruthy()
  const link = screen.getByRole('link', { name: 'Open the run' })
  expect(link.getAttribute('href')).toContain('brief-activity')
  expect(screen.getByRole('button', { name: 'Show plan and steps' })).toBeTruthy()
})

test('a recipe whose run is not in the list says so', async () => {
  stub({})
  const job = makeJob({ recipe: { kind: 'workflow', ref: 'wf-missing' } })
  renderInRoom(<TopicInfo roomId="room-1" job={job} agents={agents} />)
  expect(await screen.findByText(/isn’t in the run list/)).toBeTruthy()
})

test('report-back state and its protected Send show for a job from an outside ticket', async () => {
  const job = makeJob({
    source: {
      app: 'Tickets app',
      ref: 'TCK-142',
      title: 'Login times out',
      link: 'https://tickets.example.com/t/142',
      triggerId: 'trigger-1',
      missing: [],
    },
    reportBack: { state: 'needs_ok', tool: 'add_comment', at: null },
  })
  stub({ jobs: [job] })
  renderInRoom(<TopicInfo roomId="room-1" job={job} agents={agents} />)
  const line = await screen.findByText(/Send the result back to TCK-142\?/)
  expect(line.closest('[data-protected]')?.getAttribute('data-protected')).toBe('block')
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
})

test('Stop asks first, then stops the job', async () => {
  const fetchMock = stub({})
  renderInRoom(<TopicInfo roomId="room-1" job={makeJob()} agents={agents} />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(screen.getByRole('alertdialog', { name: 'Stop Activity feed?' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop job' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/jobs/job-1/stop' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  expect(await screen.findByText('Stop sent.')).toBeTruthy()
})

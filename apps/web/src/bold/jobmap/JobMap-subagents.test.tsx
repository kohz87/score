import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { Job, SubagentRow } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { agents, events, fullRun, plainRun } from './job-map-fixtures.ts'
import { JobMapView } from './JobMap.tsx'

afterEach(() => cleanup())

const stop = { mutate: () => {}, mutateAsync: async () => {}, isPending: false, error: null }
const now = Date.parse('2026-10-28T10:00:00Z')

const job = {
  id: 'job-1',
  subagents: { enabled: true, maxConcurrent: null, maxTotal: 20, used: 6 },
} as unknown as Job
const row = (id: string, patch: Partial<SubagentRow>): SubagentRow => ({
  id,
  jobId: 'job-1',
  agentId: 'lead',
  goal: `goal ${id}`,
  state: 'done',
  waitingOnYou: false,
  startedAt: '2026-10-28T10:00:00.000Z',
  endedAt: '2026-10-28T10:00:12.000Z',
  costUsd: 0.02,
  tokens: null,
  ...patch,
})
const rows = [
  row('a', { goal: 'Read how the feed API works' }),
  row('b', {
    goal: 'Find every place that lists events',
    endedAt: '2026-10-28T10:00:09.000Z',
    costUsd: 0.01,
  }),
  row('c', { goal: 'Draft the cursor query', endedAt: '2026-10-28T10:00:31.000Z', costUsd: 0.05 }),
  row('d', {
    goal: 'Add the virtual list',
    state: 'running',
    endedAt: null,
    costUsd: null,
    waitingOnYou: true,
  }),
]
const ceiling = {
  agentId: 'lead',
  control: 'limits',
  enabled: true,
  maxConcurrent: 4,
  model: null,
  maxIterations: 50,
  timeoutSeconds: null,
} as const

// A run that names voters only (SA.3): no helper agents, so no swarm layer; its votes still show.
const votersOnly = {
  ...fullRun,
  helpers: {
    agentIds: [],
    maxConcurrent: 3,
    maxSteps: null,
    used: 0,
    scan: false,
    scanFolder: null,
    splitTo: 'lead',
    voterIds: ['designer'],
    votes: fullRun.helpers?.votes ?? [],
  },
  stepsList: fullRun.stepsList.filter((step) => step.role !== 'helper'),
}

const view = (
  run = plainRun,
  subagents: Parameters<typeof JobMapView>[0]['subagents'] = { job, rows, ceiling },
) =>
  render(
    <JobMapView
      run={run}
      events={events}
      agents={agents}
      stop={stop as unknown as Parameters<typeof JobMapView>[0]['stop']}
      now={now}
      subagents={subagents}
    />,
  )

test('the SUBAGENTS node and the header line show with rows', () => {
  view()
  expect(screen.getByText('6 of 20 subagents used')).toBeTruthy()
  expect(
    screen.getByRole('button', {
      name: 'Subagents layer: 4 subagents, 3 done, lead’s own helpers · up to 4 at once',
    }),
  ).toBeTruthy()
})

test('no rows, no SUBAGENTS node and no header line', () => {
  view(plainRun, { job, rows: [], ceiling })
  expect(screen.queryByRole('button', { name: /^Subagents layer/ })).toBeNull()
  expect(screen.queryByText(/subagents used/)).toBeNull()
})

test('selecting the node opens its panel: the three facts, each row, and the Watch note', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: /^Subagents layer/ }))
  const panel = screen.getByRole('complementary', { name: 'Subagents detail' })
  expect(within(panel).getByText('up to 4')).toBeTruthy()
  expect(within(panel).getByText('6 of 20')).toBeTruthy()
  expect(within(panel).getByText('about $0.08')).toBeTruthy()
  const states = within(panel)
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('data-state'))
  expect(states).toEqual(['Done', 'Done', 'Done', 'Waiting'])
  expect(within(panel).getByText('Find every place that lists events')).toBeTruthy()
  expect(within(panel).getByText('needs you · —')).toBeTruthy()
  expect(within(panel).getByText(/only lead reports back/)).toBeTruthy()
  expect(within(panel).queryByText(/Held back/)).toBeNull()
  // Selected layers show their own detail, so the session log's list is replaced by a pointer to Watch.
  expect(screen.getByText('Each subagent’s steps are in Watch.')).toBeTruthy()
})

test('a run with voters only has no swarm layer, and its votes still show', () => {
  view(votersOnly as typeof plainRun, { job, rows, ceiling })
  expect(screen.queryByRole('button', { name: /^Swarm layer/ })).toBeNull()
  expect(screen.queryByText('No helper work yet.')).toBeNull()
  expect(screen.getByRole('button', { name: /^Fork layer/ })).toBeTruthy()
})

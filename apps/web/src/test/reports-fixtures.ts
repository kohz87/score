import type { AgentSummary, Reports } from '@score/contract'

/** Shared Reports fixtures for the classic page and the bold Usage page. */
export const reportAgent = (
  id: string,
  name: string,
  color: string,
  shape: AgentSummary['style']['shape'],
  role = '',
) =>
  ({
    id,
    name,
    role,
    style: { color, shape },
    status: 'idle',
    activity: null,
    model: { id: 'm', label: 'M' },
    served: true,
  }) satisfies AgentSummary

export const reportAgents = [
  reportAgent('builder', 'Builder', '#19c39a', 'triangle'),
  reportAgent('reviewer', 'Reviewer', '#ffb61e', 'diamond', 'Reviews changes'),
]

export const reportFixture = (
  range: Reports['range'],
  overrides: Partial<Reports> = {},
): Reports => ({
  range,
  summary: `Summary for ${range}.`,
  totals: {
    tasksFinished: 38,
    runs: 112,
    firstPassRate: 0.71,
    medianTaskSec: 1440,
    spendUsd: 41.2,
    cacheHitRate: null,
  },
  byDay: [{ date: '2026-03-10', perAgent: { builder: 3, reviewer: 1 } }],
  timeSplit: [
    { agentId: 'builder', workingPct: 72, waitingOnYouPct: 9, waitingOnAgentPct: 19 },
    { agentId: 'reviewer', workingPct: 85, waitingOnYouPct: 0, waitingOnAgentPct: 15 },
  ],
  byAgent: [
    {
      agentId: 'builder',
      finished: 17,
      runs: 46,
      medianSec: 1860,
      firstPassRate: 0.65,
      spendUsd: 22.4,
      cacheHitRate: null,
    },
    {
      agentId: 'reviewer',
      finished: 8,
      runs: 24,
      medianSec: 540,
      firstPassRate: null,
      spendUsd: 9.3,
      cacheHitRate: null,
    },
  ],
  trend: [],
  approvals: { asked: 24, approved: 21, denied: 3, medianWaitSec: 240, insight: 'Allow installs.' },
  ...overrides,
})

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

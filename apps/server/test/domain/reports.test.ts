import { expect, test } from 'vitest'
import {
  computeReports,
  median,
  reportWindow,
  type KanbanTaskFact,
  type ReportApproval,
  type ReportInput,
  type ReportRun,
} from '../../src/domain/reports.ts'

// UTC+2 all year (no DST), so local days are easy to reason about.
const tz = 'Etc/GMT-2'
const now = Date.parse('2026-03-10T10:00:00Z')

const t = (iso: string) => Date.parse(`2026-${iso}Z`)
const kanban = (
  id: string,
  over: Partial<Omit<KanbanTaskFact, 'events'>> & { events?: [string, string][] },
): KanbanTaskFact => ({
  id,
  assignee: 'builder',
  status: 'done',
  createdAt: t('03-10T06:00:00'),
  completedAt: null,
  hasParents: false,
  ...over,
  events: (over.events ?? []).map(([kind, at]) => ({ kind, at: t(at) })),
})
const tasks: KanbanTaskFact[] = [
  kanban('k1', {
    createdAt: t('03-10T07:00:00'),
    completedAt: t('03-10T08:00:00'),
    events: [
      ['review_requested', '03-10T07:40:00'],
      ['completed', '03-10T08:00:00'],
    ],
  }),
  // A review round that sent the work back, finished at 00:30 local on the 10th.
  kanban('k2', {
    createdAt: t('03-09T20:00:00'),
    completedAt: t('03-09T22:30:00'),
    events: [
      ['review_requested', '03-09T21:00:00'],
      ['changes_requested', '03-09T21:30:00'],
      ['review_requested', '03-09T22:00:00'],
      ['completed', '03-09T22:30:00'],
    ],
  }),
  // Finished without a review: 23:30 local on the 9th.
  kanban('k3', { createdAt: t('03-09T21:00:00'), completedAt: t('03-09T21:30:00') }),
  kanban('k4', {
    assignee: 'designer',
    createdAt: t('03-05T11:40:00'),
    completedAt: t('03-05T12:00:00'),
    events: [
      ['review_requested', '03-05T11:50:00'],
      ['completed', '03-05T12:00:00'],
    ],
  }),
  kanban('k5', {
    assignee: 'designer',
    createdAt: t('03-01T11:00:00'),
    completedAt: t('03-01T12:00:00'),
  }),
  kanban('k6', { status: 'running' }),
  kanban('k7', { status: 'blocked', events: [['blocked', '03-10T09:00:00']] }),
  // Had parents: waited 06:00-07:00 until promoted.
  kanban('k8', {
    assignee: 'designer',
    status: 'ready',
    hasParents: true,
    events: [['promoted', '03-10T07:00:00']],
  }),
  // Has parents and is still waiting for them.
  kanban('k9', { status: 'todo', hasParents: true, createdAt: t('03-10T09:30:00') }),
]
const run = (agentId: string, startedAt: string, endedAt: string | null): ReportRun => ({
  agentId,
  startedAt,
  endedAt,
})
const runs = [
  run('builder', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z'),
  run('builder', '2026-03-10T08:30:00.000Z', '2026-03-10T09:30:00.000Z'),
  run('designer', '2026-03-05T10:00:00.000Z', '2026-03-05T10:10:00.000Z'),
  run('designer', '2026-03-01T10:00:00.000Z', '2026-03-01T10:10:00.000Z'),
]
const approval = (over: Partial<ReportApproval>): ReportApproval => ({
  agentId: 'builder',
  stage: 'human',
  visible: true,
  status: 'approved',
  decisionBy: 'you',
  createdAt: '2026-03-10T08:00:00.000Z',
  decidedAt: '2026-03-10T08:10:00.000Z',
  closedAt: null,
  ...over,
})
const approvals = [
  approval({}),
  approval({
    status: 'denied',
    createdAt: '2026-03-10T09:00:00.000Z',
    decidedAt: '2026-03-10T09:30:00.000Z',
  }),
  approval({ visible: false, createdAt: '2026-03-10T08:00:00.000Z' }),
  approval({
    stage: 'guardian',
    visible: false,
    decisionBy: 'guardian',
    createdAt: '2026-03-10T07:00:00.000Z',
    decidedAt: '2026-03-10T07:30:00.000Z',
  }),
  approval({
    agentId: 'designer',
    status: 'pending',
    decisionBy: null,
    createdAt: '2026-03-10T09:00:00.000Z',
    decidedAt: null,
  }),
]
const input: ReportInput = {
  range: '7d',
  now,
  tz,
  agentIds: ['builder', 'designer', 'reviewer'],
  runs,
  approvals,
  facts: { tasks, spendUsd: { builder: 1.5, designer: null, reviewer: 0.25 } },
}

test('windows follow local calendar days', () => {
  const week = reportWindow('7d', now, tz)
  expect(week.days[0]).toBe('2026-03-04')
  expect(week.days).toHaveLength(7)
  expect(new Date(week.from).toISOString()).toBe('2026-03-03T22:00:00.000Z')
  expect(new Date(reportWindow('today', now, tz).from).toISOString()).toBe(
    '2026-03-09T22:00:00.000Z',
  )
  expect(reportWindow('30d', now, tz).days.at(-1)).toBe('2026-03-10')
})

test('median handles empty, odd and even sets', () => {
  expect([median([]), median([3, 1, 2]), median([4, 1, 2, 3])]).toEqual([null, 2, 2.5])
})

test('7d report has known numbers', () => {
  const report = computeReports(input)
  expect(report.totals).toEqual({
    tasksFinished: 4,
    runs: 3,
    firstPassRate: 2 / 3,
    medianTaskSec: 2700,
    spendUsd: 1.75,
  })
  expect(report.summary).toBe('4 tasks finished in the last 7 days, typically in 45 minutes.')
  expect(report.byDay.map((day) => day.date)).toEqual([
    '2026-03-04',
    '2026-03-05',
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
    '2026-03-09',
    '2026-03-10',
  ])
  const day = (date: string) => report.byDay.find((entry) => entry.date === date)!.perAgent
  expect(day('2026-03-05')).toEqual({ builder: 0, designer: 1 })
  expect(day('2026-03-09')).toEqual({ builder: 1, designer: 0 }) // 23:30 local
  expect(day('2026-03-10')).toEqual({ builder: 2, designer: 0 }) // 00:30 local counts on the 10th
  expect(report.byAgent).toEqual([
    {
      agentId: 'builder',
      finished: 3,
      runs: 2,
      medianSec: 3600,
      firstPassRate: 0.5,
      spendUsd: 1.5,
    },
    {
      agentId: 'designer',
      finished: 1,
      runs: 1,
      medianSec: 1200,
      firstPassRate: 1,
      spendUsd: null,
    },
    {
      agentId: 'reviewer',
      finished: 0,
      runs: 0,
      medianSec: null,
      firstPassRate: null,
      spendUsd: 0.25,
    },
  ])
  expect(report.timeSplit).toEqual([
    { agentId: 'builder', workingPct: 33, waitingOnYouPct: 26, waitingOnAgentPct: 41 },
    { agentId: 'designer', workingPct: 7, waitingOnYouPct: 43, waitingOnAgentPct: 50 },
    { agentId: 'reviewer', workingPct: 0, waitingOnYouPct: 0, waitingOnAgentPct: 0 },
  ])
  expect(report.approvals).toEqual({
    asked: 3,
    approved: 1,
    denied: 1,
    medianWaitSec: 1200,
    insight: null,
  })
})

test('today only counts the local day', () => {
  const report = computeReports({ ...input, range: 'today' })
  expect(report.totals.tasksFinished).toBe(2)
  expect(report.totals.medianTaskSec).toBe(6300)
  expect(report.byDay).toEqual([{ date: '2026-03-10', perAgent: { builder: 2 } }])
  expect(report.summary).toBe('2 tasks finished today, typically in 1.8 hours.')
})

test('empty data is null-safe', () => {
  const report = computeReports({
    range: '30d',
    now,
    tz,
    agentIds: [],
    runs: [],
    approvals: [],
    facts: { tasks: [], spendUsd: {} },
  })
  expect(report.totals).toEqual({
    tasksFinished: 0,
    runs: 0,
    firstPassRate: null,
    medianTaskSec: null,
    spendUsd: null,
  })
  expect(report.summary).toBe('No tasks finished in the last 30 days.')
  expect(report.byDay).toHaveLength(30)
  expect(report.approvals.medianWaitSec).toBeNull()
})

test('a run still open counts until now, hides waiting it overlaps, and approving everything yields an insight', () => {
  const report = computeReports({
    ...input,
    runs: [run('builder', '2026-03-10T09:00:00.000Z', null)],
    approvals: Array.from({ length: 5 }, () => approval({})),
  })
  expect(report.timeSplit[0]).toMatchObject({
    workingPct: 29,
    waitingOnYouPct: 33,
    waitingOnAgentPct: 38,
  })
  expect(report.approvals.insight).toContain('all 5')
})

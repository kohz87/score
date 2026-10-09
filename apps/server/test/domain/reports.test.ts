import { expect, test } from 'vitest'
import {
  computeReports,
  customRangeProblem,
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
  events: (over.events ?? []).map(([kind, at], index) => ({
    id: index + 1,
    kind,
    at: t(at),
    // The implementer (the task's assignee in these fixtures) waits on a review.
    actor: kind === 'review_requested' ? (over.assignee ?? 'builder') : null,
  })),
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

test('custom windows cover inclusive local days, also across a DST change', () => {
  const later = Date.parse('2026-04-05T12:00:00Z')
  const window = reportWindow('custom', later, 'Europe/London', {
    from: '2026-03-28',
    to: '2026-03-30',
  })
  expect(window.days).toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
  expect(new Date(window.from).toISOString()).toBe('2026-03-28T00:00:00.000Z')
  // 30 March ends at 23:00Z (BST), so the window is 71 hours long, not 72.
  expect(new Date(window.to).toISOString()).toBe('2026-03-30T22:59:59.999Z')
  // Ending today, the window ends now.
  expect(reportWindow('custom', now, tz, { from: '2026-03-10', to: '2026-03-10' }).to).toBe(now)
  expect(
    reportWindow('custom', now, tz, { from: '2025-03-10', to: '2026-03-10' }).days,
  ).toHaveLength(366)
})

test('custom ranges are validated', () => {
  const problem = (from: string, to: string) => customRangeProblem({ from, to }, now, tz)
  expect(problem('2026-03-01', '2026-03-10')).toBeNull()
  expect(problem('2026-03-05', '2026-03-04')).toMatch(/after to/)
  expect(problem('2026-03-05', '2026-03-11')).toMatch(/after today/)
  expect(problem('2025-03-10', '2026-03-10')).toBeNull() // 366 days
  expect(problem('2025-03-09', '2026-03-10')).toMatch(/at most 366/)
  expect(problem('2026-02-30', '2026-03-01')).toMatch(/real dates/)
  expect(problem('yesterday', '2026-03-01')).toMatch(/real dates/)
})

test('a custom report buckets per local day for any length and names its range', () => {
  for (const [from, count] of [
    ['2026-03-10', 1],
    ['2026-03-09', 2],
    ['2026-01-25', 45],
    ['2025-03-10', 366],
  ] as const) {
    const report = computeReports({ ...input, range: 'custom', custom: { from, to: '2026-03-10' } })
    expect(report.range).toBe('custom')
    expect(report.byDay).toHaveLength(count)
  }
  const one = computeReports({
    ...input,
    range: 'custom',
    custom: { from: '2026-03-09', to: '2026-03-09' },
  })
  expect(one.summary).toMatch(/on 2026-03-09|No tasks finished on 2026-03-09/)
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
    // designer's spend is unknown, so the total is unknown rather than a partial 1.75.
    spendUsd: null,
    cacheHitRate: null,
  })
  expect(
    computeReports({
      ...input,
      facts: { ...input.facts, spendUsd: { builder: 1.5, designer: 0, reviewer: 0.25 } },
    }).totals.spendUsd,
  ).toBe(1.75)
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
      cacheHitRate: null,
    },
    {
      agentId: 'designer',
      finished: 1,
      runs: 1,
      medianSec: 1200,
      firstPassRate: 1,
      spendUsd: null,
      cacheHitRate: null,
    },
    {
      agentId: 'reviewer',
      finished: 0,
      runs: 0,
      medianSec: null,
      firstPassRate: null,
      spendUsd: 0.25,
      cacheHitRate: null,
    },
  ])
  expect(report.timeSplit).toEqual([
    { agentId: 'builder', workingPct: 45, waitingOnYouPct: 15, waitingOnAgentPct: 40 },
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

test('archiving a finished task does not remove it from the reports', () => {
  const archived = input.facts.tasks.map((task) =>
    task.status === 'done' ? { ...task, status: 'archived' } : task,
  )
  const report = computeReports({ ...input, facts: { ...input.facts, tasks: archived } })
  expect(report.totals.tasksFinished).toBe(computeReports(input).totals.tasksFinished)
  expect(report.totals.tasksFinished).toBeGreaterThan(0)
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
    cacheHitRate: null,
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
    workingPct: 40,
    waitingOnYouPct: 7,
    waitingOnAgentPct: 53,
  })
  expect(report.approvals.insight).toContain('all 5')
})

test('time categories are disjoint: an hour working with the same hour waiting on you counts once, as working', () => {
  const hour = (iso: string) => Date.parse(`2026-03-10T${iso}Z`)
  const report = computeReports({
    ...input,
    agentIds: ['builder'],
    runs: [run('builder', '2026-03-10T08:00:00.000Z', '2026-03-10T09:00:00.000Z')],
    approvals: [
      approval({ createdAt: '2026-03-10T08:00:00.000Z', decidedAt: '2026-03-10T09:00:00.000Z' }),
    ],
    facts: { tasks: [], spendUsd: {} },
  })
  expect(report.timeSplit[0]).toEqual({
    agentId: 'builder',
    workingPct: 100,
    waitingOnYouPct: 0,
    waitingOnAgentPct: 0,
  })
  // Waiting on you beats waiting on another agent where they overlap (08:00-09:00 both).
  const both = computeReports({
    ...input,
    agentIds: ['builder'],
    runs: [],
    approvals: [
      approval({ createdAt: '2026-03-10T08:00:00.000Z', decidedAt: '2026-03-10T09:00:00.000Z' }),
    ],
    facts: {
      tasks: [
        kanban('w', {
          status: 'review',
          createdAt: hour('07:00:00'),
          events: [['review_requested', '03-10T08:00:00']],
        }),
      ],
      spendUsd: {},
    },
  })
  // you: 08:00-09:00 (60m); agent: 09:00-10:00 (60m, still in review) - never 120m of agent time.
  expect(both.timeSplit[0]).toMatchObject({ waitingOnYouPct: 50, waitingOnAgentPct: 50 })
})

test('a review wait belongs to the implementer, ordered by event id, not the current assignee', () => {
  // Hermes reassigned the task to the reviewer; the closure shares the request's second but has the higher id.
  const reviewTask: KanbanTaskFact = {
    id: 'k-own',
    assignee: 'reviewer',
    status: 'done',
    createdAt: t('03-10T07:00:00'),
    completedAt: t('03-10T08:00:00'),
    hasParents: false,
    events: [
      { id: 7, kind: 'changes_requested', at: t('03-10T07:30:00'), actor: 'builder' },
      { id: 5, kind: 'review_requested', at: t('03-10T07:30:00'), actor: 'builder' },
      { id: 9, kind: 'review_requested', at: t('03-10T07:45:00'), actor: 'builder' },
      { id: 11, kind: 'completed', at: t('03-10T08:00:00'), actor: null },
    ],
  }
  const report = computeReports({
    ...input,
    runs: [],
    approvals: [],
    range: 'today',
    facts: { tasks: [reviewTask], spendUsd: {} },
  })
  const split = Object.fromEntries(report.timeSplit.map((row) => [row.agentId, row]))
  // builder waited 07:30-07:30 (zero) then 07:45-08:00: not the reviewer, and the first request is not
  // closed by an earlier-id event at the same second.
  expect(split.builder!.waitingOnAgentPct).toBeGreaterThan(0)
  expect(split.reviewer!.waitingOnAgentPct).toBe(0)
})

test('cache hit rate per agent and in total; unknown stays null', () => {
  const report = computeReports({
    ...input,
    facts: {
      ...input.facts,
      cache: {
        builder: { read: 750, total: 1000 },
        designer: null,
        reviewer: { read: 0, total: 1000 },
      },
    },
  })
  expect(report.byAgent.map((row) => row.cacheHitRate)).toEqual([0.75, null, 0])
  // Over the agents that report: (750 + 0) / (1000 + 1000).
  expect(report.totals.cacheHitRate).toBe(0.375)
})

test('a 366-day custom report with many tasks computes quickly (no per-task formatter construction)', () => {
  const day = 86_400_000
  const end = Date.parse('2026-10-09T12:00:00Z')
  const many = Array.from({ length: 300 }, (_, i) =>
    kanban(`p${i}`, {
      assignee: ['builder', 'designer', 'lead'][i % 3]!,
      createdAt: end - (i + 2) * day,
      completedAt: end - (i + 1) * day,
    }),
  )
  const started = performance.now()
  const result = computeReports({
    range: 'custom',
    custom: { from: '2025-10-09', to: '2026-10-09' },
    now: end,
    tz: 'America/New_York',
    agentIds: ['builder', 'designer', 'lead'],
    runs: [],
    approvals: [],
    facts: { tasks: many, spendUsd: {} },
  })
  expect(performance.now() - started).toBeLessThan(2000)
  expect(result.byDay).toHaveLength(366)
  expect(
    result.byDay.reduce(
      (n, d) => n + Object.values(d.perAgent).reduce((a, b) => a + b, 0),
      0,
    ),
  ).toBe(300)
})

test('a local day whose midnight does not exist starts at the first valid instant of that day', () => {
  // Santiago skips 00:00 on 2026-09-06 (clocks jump 00:00 -> 01:00).
  const start = reportWindow('custom', Date.parse('2026-09-10T12:00:00Z'), 'America/Santiago', {
    from: '2026-09-06',
    to: '2026-09-06',
  }).from
  expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(start)).toBe(
    '2026-09-06',
  )
  expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(start - 1)).toBe(
    '2026-09-05',
  )
})

test('malformed custom dates are a problem, never an exception', () => {
  expect(customRangeProblem({ from: '2026-13-01', to: '2026-13-02' }, now, tz)).toMatch(
    /real dates/,
  )
  expect(customRangeProblem({ from: '2026-02-30', to: '2026-03-01' }, now, tz)).toMatch(
    /real dates/,
  )
  expect(customRangeProblem({ from: '9999-99-99', to: '2026-03-01' }, now, tz)).toMatch(
    /real dates/,
  )
})

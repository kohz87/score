import { expect, test } from 'vitest'
import { computeReports, median, type KanbanTaskFact } from '../../src/domain/reports.ts'
import { approval, input, kanban, now, run, t, tz } from './reports-helpers.ts'

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

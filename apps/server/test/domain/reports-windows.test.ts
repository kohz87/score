import { expect, test } from 'vitest'
import { computeReports, customRangeProblem, reportWindow } from '../../src/domain/reports.ts'
import { input, kanban, now, tz } from './reports-helpers.ts'

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
    result.byDay.reduce((n, d) => n + Object.values(d.perAgent).reduce((a, b) => a + b, 0), 0),
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

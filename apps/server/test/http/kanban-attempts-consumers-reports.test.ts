import { ReportsSchema } from '@score/contract'
import { describe, expect, test } from 'vitest'
import { computeReports } from '../../src/domain/reports.ts'
import { withFlag } from '../helpers/kanban-attempts-seed.ts'
import {
  body,
  iso,
  seedWorld,
  setupKanbanAttemptsConsumersTest,
} from './kanban-attempts-consumers-helpers.ts'

setupKanbanAttemptsConsumersTest()

describe('Reports', () => {
  test('attempts count as runs; partial ones are never working time; unknown agents get their own bucket', async () => {
    seedWorld()
    const off = ReportsSchema.parse(
      JSON.parse((await body('/api/reports?range=today&tz=UTC')).text),
    )
    expect(off.unattributed).toBeUndefined()
    withFlag(true)
    const report = ReportsSchema.parse(
      JSON.parse((await body('/api/reports?range=today&tz=UTC')).text),
    )
    const builder = report.byAgent.find((row) => row.agentId === 'builder')!
    const baseline = off.byAgent.find((row) => row.agentId === 'builder')?.runs ?? 0
    // Attempts 1, 3, 7, 8 and 10 (the earlier board's) are the builder's; the ancestral copy is excluded.
    expect(builder.runs - baseline).toBe(5)
    expect(report.byAgent.find((row) => row.agentId === 'reviewer')!.runs).toBe(2)
    // Unattributed: attempt 5 (proven, 10 minutes) and 6 (partial, still observed; never working time).
    expect(report.unattributed).toEqual({ runs: 2, workingSec: 600 })
    expect(report.totals.runs - off.totals.runs).toBe(7)
    // The trend counts the attributed attempts too (and not the unattributed ones).
    expect(report.trend.at(-1)!.runs - off.trend.at(-1)!.runs).toBe(7)
  })

  test('the CSV counts attempts per agent and adds an Unattributed row', async () => {
    seedWorld()
    withFlag(true)
    const csv = (await body('/api/reports/export.csv?range=today&tz=UTC')).text
    const rows = csv.trim().split('\r\n')
    expect(rows.at(-1)).toBe('Unknown agent,,2,,,')
    expect(rows.some((row) => row.startsWith('Builder,') || row.startsWith('builder,'))).toBe(true)
  })
})

describe('report arithmetic with attempts', () => {
  const base = {
    range: 'today' as const,
    now: Date.parse('2026-10-09T12:00:00.000Z'),
    tz: 'UTC',
    agentIds: ['builder'],
    runs: [],
    approvals: [],
    facts: { tasks: [], spendUsd: { builder: 0 } },
  }
  test('unknown-agent working time covers proven attempts only and stops at the observation boundary', () => {
    const report = computeReports({
      ...base,
      attempts: [
        { agentId: null, startedAt: iso('11:00'), endedAt: iso('11:10'), evidence: 'proven' },
        // Observation ended at 11:45: 5 proven minutes, not 20.
        { agentId: null, startedAt: iso('11:40'), endedAt: iso('11:45'), evidence: 'proven' },
        // Still running but never proven: a run, not working time.
        { agentId: null, startedAt: iso('11:50'), endedAt: null, evidence: 'partial' },
      ],
    })
    expect(report.unattributed).toEqual({ runs: 3, workingSec: 900 })
    // The bucket is separate from every agent total.
    expect(report.totals.runs).toBe(0)
    expect(report.byAgent.map((row) => row.runs)).toEqual([0])
  })
  test('an agent attempt is a run; only a proven one is working time', () => {
    const proven = computeReports({
      ...base,
      attempts: [
        { agentId: 'builder', startedAt: iso('10:00'), endedAt: iso('10:30'), evidence: 'proven' },
      ],
    })
    const partial = computeReports({
      ...base,
      attempts: [
        { agentId: 'builder', startedAt: iso('10:00'), endedAt: iso('10:30'), evidence: 'partial' },
      ],
    })
    expect(proven.byAgent[0]!.runs).toBe(1)
    expect(partial.byAgent[0]!.runs).toBe(1)
    expect(proven.timeSplit[0]!.workingPct).toBe(100)
    expect(partial.timeSplit[0]!.workingPct).toBe(0)
  })
  test('without attempts the report has no unattributed bucket', () => {
    expect(computeReports(base).unattributed).toBeUndefined()
  })
})

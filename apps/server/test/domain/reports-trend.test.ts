import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { computeTrend } from '../../src/domain/reports-trend.ts'

const now = Date.parse('2026-03-10T12:00:00Z')

test('30 local days with runs counted on the viewer day and unknown spend as null', () => {
  const trend = computeTrend({
    now,
    tz: 'America/New_York',
    runs: [
      { agentId: 'a', startedAt: '2026-03-10T03:00:00Z', endedAt: null }, // 23:00 on the 9th, local
      { agentId: 'a', startedAt: '2026-03-10T10:00:00Z', endedAt: null },
      { agentId: 'b', startedAt: '2026-03-10T11:00:00Z', endedAt: null },
    ],
  })
  expect(trend).toHaveLength(30)
  expect(trend.at(-1)).toEqual({ date: '2026-03-10', runs: 2, spendUsd: null })
  expect(trend.at(-2)).toEqual({ date: '2026-03-09', runs: 1, spendUsd: null })
  expect(trend[0]!.date).toBe('2026-02-09')
})

test('daily spend is each day share of the cost snapshots, summed over agents', () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE session_cost_snapshots (profile TEXT, session_id TEXT, hour INTEGER, observed_at INTEGER,
    cost_usd REAL, estimated INTEGER, PRIMARY KEY (profile, session_id, hour))`)
  const insert = sqlite.prepare('INSERT INTO session_cost_snapshots VALUES (?, ?, ?, ?, ?, 0)')
  const at = (iso: string) => Date.parse(iso)
  insert.run('a', 's1', 1, at('2026-03-09T12:00:00Z'), 1)
  insert.run('a', 's1', 2, at('2026-03-10T08:00:00Z'), 3.5)
  const trend = computeTrend({
    now,
    tz: 'UTC',
    runs: [],
    sqlite,
    costs: {
      a: [
        { sessionId: 's1', startedAt: at('2026-03-09T10:00:00Z'), costUsd: 3.5, estimated: false },
      ],
    },
  })
  expect(trend.at(-1)!.spendUsd).toBe(2.5)
  expect(trend.at(-2)!.spendUsd).toBe(1)
  // Before the session existed: no spend.
  expect(trend.at(-3)!.spendUsd).toBe(0)
  sqlite.close()
})

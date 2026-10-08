import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { migrate } from '../../src/db/migrate.ts'
import {
  profileSpendInWindow,
  recordSessionCosts,
  SNAPSHOT_RETENTION_MS,
  type SessionCost,
} from '../../src/domain/spend.ts'
import { fileURLToPath } from 'node:url'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-spend-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const H = 3_600_000
const midnight = Date.parse('2026-03-10T00:00:00Z')
const session = (costUsd: number | null, startedAt: number): SessionCost => ({
  sessionId: 's1',
  startedAt,
  costUsd,
  estimated: false,
})
const record = (cost: number, at: number, startedAt = midnight - 5 * H) =>
  recordSessionCosts(db.sqlite, 'builder', [session(cost, startedAt)], at)
const spend = (from: number, to: number, cost: number | null, startedAt = midnight - 5 * H) =>
  profileSpendInWindow(db.sqlite, 'builder', [session(cost, startedAt)], from, to)

test('a session crossing midnight is split across the two days', () => {
  record(1, midnight - 4 * H)
  record(3, midnight - 30 * 60_000)
  record(7, midnight + 2 * H)
  record(8, midnight + 20 * H)
  expect(spend(midnight - 24 * H, midnight - 1, 3)).toBeCloseTo(3) // started inside the previous day
  expect(spend(midnight, midnight + 24 * H, 8)).toBeCloseTo(5) // 8 now minus 3 before midnight
})

test('spend is unknown before the first snapshot of a session that started earlier', () => {
  record(4, midnight + H)
  expect(spend(midnight, midnight + 24 * H, 4)).toBeNull()
  // A session that started inside the window has a zero baseline.
  expect(spend(midnight, midnight + 24 * H, 4, midnight + 30 * 60_000)).toBeCloseTo(4)
  // Unknown cost stays unknown.
  expect(spend(midnight, midnight + 24 * H, null, midnight + 1)).toBeNull()
})

test('growth is bounded: one row per session per quarter hour, nothing older than 60 days', () => {
  for (let minute = 0; minute < 60; minute += 10) record(minute, midnight + minute * 60_000)
  record(99, midnight + H)
  const count = () =>
    (db.sqlite.prepare('SELECT COUNT(*) AS n FROM session_cost_snapshots').get() as { n: number }).n
  expect(count()).toBe(5)
  expect(
    db.sqlite.prepare('SELECT cost_usd FROM session_cost_snapshots ORDER BY hour LIMIT 1').get(),
  ).toEqual({ cost_usd: 10 })
  record(100, midnight + SNAPSHOT_RETENTION_MS + 2 * H)
  expect(count()).toBe(1)
})

test('readings either side of a half-hour-offset local midnight keep their baseline (Asia/Kolkata)', () => {
  const local = Date.parse('2026-03-09T18:30:00Z') // Kolkata midnight
  record(2, local - 40 * 60_000)
  record(5, local - 10 * 60_000)
  record(6, local + 10 * 60_000)
  expect(spend(local, local + 24 * H, 6)).toBeCloseTo(1)
})

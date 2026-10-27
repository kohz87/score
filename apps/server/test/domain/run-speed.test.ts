import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  applyCliTtft,
  deriveSpeed,
  markFirstOutput,
  median,
  runSpeedJson,
  speedByAgent,
} from '../../src/domain/run-speed.ts'

// 3.10.0: speed figures are measured once per run and derived; nothing missing is ever guessed.

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-speed-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, MIGRATIONS)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const T0 = '2026-10-27T10:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
function addRun(id: string, profile: string, endMs: number | null, tokens: number | null) {
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, output_tokens, updated_at)
       VALUES (?, ?, 'score', 'completed', ?, ?, ?, ?)`,
    )
    .run(id, profile, T0, endMs === null ? null : at(endMs), tokens, T0)
}
const firstOutput = (id: string) =>
  (
    db.sqlite.prepare('SELECT first_output_at AS f FROM runs WHERE id = ?').get(id) as {
      f: string | null
    }
  ).f

test('the migration adds the run and message columns', () => {
  const cols = (table: string) =>
    (db.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    )
  expect(cols('runs')).toContain('first_output_at')
  expect(cols('messages')).toContain('speed')
})

test('the first text sets first_output_at once and never moves it', () => {
  addRun('r1', 'builder', null, null)
  markFirstOutput(db.sqlite, 'r1', at(1200))
  markFirstOutput(db.sqlite, 'r1', at(3000))
  expect(firstOutput('r1')).toBe(at(1200))
})

test('a CLI-reported ttft replaces the measurement', () => {
  addRun('r1', 'builder', null, null)
  markFirstOutput(db.sqlite, 'r1', at(1200))
  applyCliTtft(db.sqlite, 'r1', 800)
  expect(firstOutput('r1')).toBe(at(800))
  applyCliTtft(db.sqlite, 'r1', -5)
  applyCliTtft(db.sqlite, 'r1', Number.NaN)
  expect(firstOutput('r1')).toBe(at(800))
})

test('derived figures: ttft, tokens per second, and the null cases', () => {
  const run = { startedAt: T0, firstOutputAt: at(1000), endedAt: at(3000), outputTokens: 100 }
  expect(deriveSpeed(run)).toEqual({ ttftMs: 1000, tokensPerSecond: 50, outputTokens: 100 })
  // Span under 0.5 s: no rate.
  expect(deriveSpeed({ ...run, endedAt: at(1400) }).tokensPerSecond).toBeNull()
  // No first output: neither ttft nor rate.
  expect(deriveSpeed({ ...run, firstOutputAt: null })).toEqual({
    ttftMs: null,
    tokensPerSecond: null,
    outputTokens: 100,
  })
  // Not ended / no tokens.
  expect(deriveSpeed({ ...run, endedAt: null }).tokensPerSecond).toBeNull()
  expect(deriveSpeed({ ...run, outputTokens: null })).toMatchObject({
    tokensPerSecond: null,
    outputTokens: null,
  })
  expect(deriveSpeed({ ...run, outputTokens: 0 }).tokensPerSecond).toBeNull()
})

test('runSpeedJson is null when nothing was measured', () => {
  addRun('empty', 'builder', null, null)
  expect(runSpeedJson(db.sqlite, 'empty')).toBeNull()
  addRun('full', 'builder', 3000, 100)
  markFirstOutput(db.sqlite, 'full', at(1000))
  expect(JSON.parse(runSpeedJson(db.sqlite, 'full')!)).toEqual({
    ttftMs: 1000,
    tokensPerSecond: 50,
    outputTokens: 100,
  })
})

test('medians per agent over the window, with run counts', () => {
  for (const [id, first, end, tokens] of [
    ['a', 1000, 3000, 100],
    ['b', 3000, 5000, 400],
    ['c', 2000, 4000, 200],
  ] as const) {
    addRun(id, 'builder', end, tokens)
    markFirstOutput(db.sqlite, id, at(first))
  }
  addRun('d', 'reviewer', 2000, 10) // no first output: not counted
  const rows = speedByAgent(db.sqlite, Date.parse(T0) - 1000, Date.parse(T0) + 1000)
  expect(rows).toEqual([
    { agentId: 'builder', runs: 3, medianTtftMs: 2000, medianTokensPerSecond: 100 },
  ])
  expect(speedByAgent(db.sqlite, Date.parse(T0) + 5000, Date.parse(T0) + 9000)).toEqual([])
  expect(median([])).toBeNull()
  expect(median([1, 3])).toBe(2)
})

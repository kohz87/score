import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { messageFromRow } from '../../src/domain/rooms.ts'
import { appendRunMessage } from '../../src/domain/message-runs.ts'
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

test('a CLI ttft outside the run (after its end) is ignored; Score’s measurement stays', () => {
  addRun('r1', 'builder', 3000, 100)
  markFirstOutput(db.sqlite, 'r1', at(1000))
  applyCliTtft(db.sqlite, 'r1', 9000)
  expect(firstOutput('r1')).toBe(at(1000))
  applyCliTtft(db.sqlite, 'r1', 2000)
  expect(firstOutput('r1')).toBe(at(2000))
  // Run not ended yet in the row: the terminal's own end time bounds it.
  addRun('r2', 'builder', null, null)
  markFirstOutput(db.sqlite, 'r2', at(500))
  applyCliTtft(db.sqlite, 'r2', 9000, at(3000))
  expect(firstOutput('r2')).toBe(at(500))
})

test('a malformed or old-shaped stored speed reads as none and never breaks the message', () => {
  const insert = db.sqlite.prepare(
    `INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('rm', 'R', 'room', '[]', ?, ?)`,
  )
  insert.run(T0, T0)
  const row = (speed: string | null) => ({
    id: 'm1',
    room_id: 'rm',
    author_kind: 'agent',
    author_agent_id: 'builder',
    to: '[]',
    parts: '[]',
    refs: '[]',
    streaming: 0,
    created_at: T0,
    updated_at: T0,
    version: 1,
    speed,
  })
  expect(messageFromRow(row('{not json')).speed).toBeUndefined()
  expect(messageFromRow(row('{"tps":3}')).speed).toBeUndefined()
  expect(
    messageFromRow(row('{"ttftMs":-1,"tokensPerSecond":null,"outputTokens":null}')).speed,
  ).toBeUndefined()
  expect(messageFromRow(row('{"ttftMs":5,"tokensPerSecond":null,"outputTokens":2}')).speed).toEqual(
    {
      ttftMs: 5,
      tokensPerSecond: null,
      outputTokens: 2,
    },
  )
})

test('whitespace-only text is not the first output', () => {
  db.sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('rm', 'R', 'room', '[]', ?, ?)`,
    )
    .run(T0, T0)
  addRun('r1', 'builder', null, null)
  appendRunMessage(db.sqlite, 'r1', '  \n', at(100))
  expect(firstOutput('r1')).toBeNull()
  appendRunMessage(db.sqlite, 'r1', 'Hello', at(200))
  expect(firstOutput('r1')).toBe(at(200))
})

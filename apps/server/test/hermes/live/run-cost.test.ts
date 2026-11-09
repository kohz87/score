import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import {
  readSessionTreeCost,
  runCostObservation,
  type SessionTreeCost,
} from '../../../src/hermes/live/run-cost.ts'

let dir: string
let db: ScoreDb
let state: DatabaseSync

const row = (
  id: string,
  values: {
    parent?: string
    status?: string | null
    estimated?: number | null
    actual?: number | null
    tokens?: number
    startedAt?: number
  },
) =>
  state
    .prepare(
      `INSERT INTO sessions (id, parent_session_id, started_at, cost_status, estimated_cost_usd, actual_cost_usd,
         input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      values.parent ?? null,
      values.startedAt ?? 2000,
      values.status === undefined ? 'estimated' : values.status,
      values.estimated ?? null,
      values.actual ?? null,
      values.tokens ?? 100,
    )

const addRun = (
  id: string,
  started: string,
  cost: number | null = null,
  session: string | null = 'score-1',
) =>
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO runs (id, profile, origin, session_id, status, started_at, version, updated_at, cost_usd)
         VALUES (?, 'lead', 'score', ?, 'completed', ?, 1, ?, ?)`,
      )
      .run(id, session, started, started, cost)
  })
const settle = (runId: string, cost: SessionTreeCost, round = 0) =>
  db.tx((sqlite) =>
    runCostObservation(runId, cost, round).apply({
      sqlite,
      now: '2026-11-09T12:00:00.000Z',
    } as never),
  )
const stored = (runId: string) =>
  db.read(
    (sqlite) =>
      sqlite.prepare('SELECT cost_usd, cost_kind, version FROM runs WHERE id = ?').get(runId) as {
        cost_usd: number | null
        cost_kind: string | null
        version: number
      },
  )
const at = (iso: string) => Date.parse(iso)
const known = (usd: number, estimated = true): SessionTreeCost => ({
  usd,
  estimated,
  startedAtMs: at('2026-11-09T10:00:00.000Z'),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-run-cost-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
  state = new DatabaseSync(':memory:')
  state.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, started_at REAL, cost_status TEXT,
    estimated_cost_usd REAL, actual_cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER)`)
})
afterEach(() => {
  state.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a session costs its own row plus its subagents and continuations', () => {
  row('score-1', { estimated: 0.0034 })
  row('child-a', { parent: 'score-1', estimated: 0.0022 })
  row('child-b', { parent: 'score-1', estimated: 0.0002 })
  row('continued', { parent: 'score-1', estimated: 0.01 })
  row('grandchild', { parent: 'continued', estimated: 0.001 })
  row('someone-else', { estimated: 5 })
  const cost = readSessionTreeCost(state, 'score-1')!
  expect(cost.usd).toBeCloseTo(0.0168)
  expect(cost.estimated).toBe(true)
  expect(cost.startedAtMs).toBe(2_000_000)
})

test('the billed cost wins, and is not an estimate', () => {
  row('score-1', { status: 'actual', actual: 0.5, estimated: 0.4 })
  expect(readSessionTreeCost(state, 'score-1')).toMatchObject({ usd: 0.5, estimated: false })
})

test('status unknown with 0.0 is unknown, not free, for the whole tree', () => {
  row('score-1', { estimated: 0.1 })
  row('child', { parent: 'score-1', status: 'unknown', estimated: 0 })
  expect(readSessionTreeCost(state, 'score-1')!.usd).toBeNull()
})

test('a subscription route costs nothing', () => {
  row('score-1', { status: 'included', estimated: 0 })
  expect(readSessionTreeCost(state, 'score-1')).toMatchObject({ usd: 0, estimated: false })
})

test('a session that never reached the model costs nothing', () => {
  row('score-1', { status: null, tokens: 0 })
  expect(readSessionTreeCost(state, 'score-1')!.usd).toBe(0)
})

test('a session Hermes does not have has no reading', () => {
  expect(readSessionTreeCost(state, 'ghost')).toBeNull()
})

test('a parent loop in the rows ends', () => {
  row('a', { parent: 'b', estimated: 1 })
  row('b', { parent: 'a', estimated: 2 })
  expect(readSessionTreeCost(state, 'a')!.usd).toBe(3)
})

test('the first run of a session gets the session total', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z')
  settle('r1', known(0.25))
  expect(stored('r1')).toMatchObject({ cost_usd: 0.25, cost_kind: 'estimated', version: 2 })
})

test('a later turn gets the difference', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z', 0.25)
  addRun('r2', '2026-11-09T10:05:00.000Z')
  settle('r2', known(0.4))
  expect(stored('r2').cost_usd).toBeCloseTo(0.15)
})

test('an earlier run with no figure makes the difference unknown', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z')
  addRun('r2', '2026-11-09T10:05:00.000Z')
  settle('r2', known(0.4))
  expect(stored('r2')).toMatchObject({ cost_usd: null, cost_kind: 'unknown' })
})

test('a room continuing an outside session is not charged its past', () => {
  addRun('r1', '2026-11-09T11:00:00.000Z')
  settle('r1', known(9))
  expect(stored('r1')).toMatchObject({ cost_usd: null, cost_kind: 'unknown' })
})

test('an unknown tree is unknown', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z')
  settle('r1', { ...known(0), usd: null })
  expect(stored('r1')).toMatchObject({ cost_usd: null, cost_kind: 'unknown' })
})

test('the second read corrects a late write, and changes nothing if nothing changed', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z')
  settle('r1', known(0.2))
  expect(settle('r1', known(0.3), 1)).toHaveLength(1)
  expect(stored('r1')).toMatchObject({ cost_usd: 0.3, version: 3 })
  expect(settle('r1', known(0.3), 2)).toEqual([])
  expect(stored('r1').version).toBe(3)
})

test('once a later turn has begun, an earlier run keeps its figure', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z', 0.2)
  addRun('r2', '2026-11-09T10:05:00.000Z')
  expect(settle('r1', known(0.9), 1)).toEqual([])
  expect(stored('r1').cost_usd).toBe(0.2)
})

test('a billed figure has no estimated kind', () => {
  addRun('r1', '2026-11-09T10:00:00.000Z')
  settle('r1', known(0.2, false))
  expect(stored('r1')).toMatchObject({ cost_usd: 0.2, cost_kind: null })
})

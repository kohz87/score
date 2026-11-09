import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { jobLimitFor } from '../../src/domain/exchanges/budget.ts'
import {
  runJobScope,
  runSubagentTotalReached,
} from '../../src/domain/orchestration/subagent-scope.ts'
import {
  allowMoreSubagents,
  ceilingOf,
  changeJobSubagents,
  effectiveLimits,
  addSubagentUse,
  jobOfSession,
  rememberSubagentSession,
  startRoomThreadCount,
  setCeiling,
  subagentSessionsOf,
  subagentTotalReached,
} from '../../src/domain/subagents.ts'

let dir: string
let db: ScoreDb

const job = (sqlite = db.sqlite) =>
  sqlite
    .prepare(
      'SELECT subagents_enabled, subagents_max_concurrent, subagents_max_total, subagents_used FROM jobs WHERE id = ?',
    )
    .get('job-1') as {
    subagents_enabled: number
    subagents_max_concurrent: number | null
    subagents_max_total: number
    subagents_used: number
  }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-subagents-domain-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing)
         VALUES ('room-1', 'Team', 'room', '[]', 'now', 'now', 'room', 'exchanges')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO jobs (id, room_id, title, session_scheme, exchange_budget, job_turn_limit, created_at, updated_at)
         VALUES ('job-1', 'room-1', 'A job', 'job', 8, 40, 'now', 'now')`,
      )
      .run()
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a new job is on, at the agent’s limit, with a total of 20', () => {
  expect(effectiveLimits(db.sqlite, 'lead', 'job-1')).toEqual({
    enabled: true,
    maxConcurrent: 4,
    maxTotal: 20,
    used: 0,
  })
})

test('a job narrows the agent, and can’t raise it', () => {
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { maxConcurrent: 2 }))
  expect(effectiveLimits(db.sqlite, 'lead', 'job-1').maxConcurrent).toBe(2)
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { maxConcurrent: 9 }))
  expect(effectiveLimits(db.sqlite, 'lead', 'job-1').maxConcurrent).toBe(4)
})

test('/subagents on goes back to the agent’s limit', () => {
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { maxConcurrent: 2 }))
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { enabled: true, maxConcurrent: null }))
  expect(job().subagents_max_concurrent).toBeNull()
  expect(effectiveLimits(db.sqlite, 'lead', 'job-1').maxConcurrent).toBe(4)
})

test('off in the agent or the job is off', () => {
  db.tx((sqlite) => setCeiling(sqlite, 'lead', { enabled: false }))
  expect(effectiveLimits(db.sqlite, 'lead', 'job-1').enabled).toBe(false)
  expect(effectiveLimits(db.sqlite, 'builder', 'job-1').enabled).toBe(true)
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { enabled: false }))
  expect(effectiveLimits(db.sqlite, 'builder', 'job-1').enabled).toBe(false)
})

test('a ceiling keeps what it isn’t changing, and survives Apply’s row', () => {
  db.tx((sqlite) => setCeiling(sqlite, 'lead', { maxConcurrent: 2 }))
  db.tx((sqlite) => setCeiling(sqlite, 'lead', { enabled: false }))
  expect(ceilingOf(db.sqlite, 'lead')).toEqual({ enabled: false, maxConcurrent: 2 })
})

test('with no job the agent’s ceiling and the default total apply', () => {
  expect(effectiveLimits(db.sqlite, 'lead', null)).toMatchObject({ maxTotal: 20, used: 0 })
})

test('an unknown job is refused', () => {
  expect(() => db.tx((sqlite) => changeJobSubagents(sqlite, 'nope', { enabled: false }))).toThrow(
    'Couldn’t find that job',
  )
})

test('a use counts against the job, and tells the room', () => {
  db.tx((sqlite) => rememberSubagentSession(sqlite, 'score-1', 'lead', 'job-1'))
  expect(jobOfSession(db.sqlite, 'score-1')).toBe('job-1')
  expect(jobOfSession(db.sqlite, 'outside')).toBeNull()
  const drafts = db.tx((sqlite) => addSubagentUse(sqlite, 'job-1'))
  expect(job().subagents_used).toBe(1)
  expect(drafts).toEqual([
    {
      type: 'subagents.changed',
      data: {
        jobId: 'job-1',
        roomId: 'room-1',
        subagents: { enabled: true, maxConcurrent: null, maxTotal: 20, used: 1 },
      },
    },
  ])
})

test('only a room’s own thread starts its count again at a new request', () => {
  db.tx((sqlite) => addSubagentUse(sqlite, 'job-1'))
  expect(db.tx((sqlite) => startRoomThreadCount(sqlite, 'job-1'))).toEqual([])
  expect(job().subagents_used).toBe(1)
  const thread = (
    db.sqlite.prepare("SELECT id FROM jobs WHERE room_id = 'room-1' AND is_default = 1").get() as {
      id: string
    }
  ).id
  db.tx((sqlite) => addSubagentUse(sqlite, thread))
  expect(db.tx((sqlite) => startRoomThreadCount(sqlite, thread))).toHaveLength(1)
  expect(effectiveLimits(db.sqlite, 'lead', thread).used).toBe(0)
  expect(db.tx((sqlite) => startRoomThreadCount(sqlite, thread))).toEqual([])
})

test('sessions of a job are listed for the refresh, and a session moves with its job', () => {
  db.tx((sqlite) => {
    rememberSubagentSession(sqlite, 'score-1', 'lead', 'job-1')
    rememberSubagentSession(sqlite, 'score-2', 'builder', 'job-1')
    rememberSubagentSession(sqlite, 'score-2', 'builder', 'job-1')
  })
  expect(subagentSessionsOf(db.sqlite, 'job-1')).toHaveLength(2)
})

test('reaching the total holds the next agent turn, and allowing more lifts it', () => {
  db.tx((sqlite) => changeJobSubagents(sqlite, 'job-1', { maxTotal: 2 }))
  db.tx((sqlite) => addSubagentUse(sqlite, 'job-1'))
  expect(subagentTotalReached(db.sqlite, 'job-1')).toBe(false)
  expect(jobLimitFor(db.sqlite, 'job-1')).toBeNull()
  db.tx((sqlite) => addSubagentUse(sqlite, 'job-1'))
  expect(subagentTotalReached(db.sqlite, 'job-1')).toBe(true)
  expect(jobLimitFor(db.sqlite, 'job-1')).toBe('subagent_total')
  db.tx((sqlite) => allowMoreSubagents(sqlite, 'job-1', 5))
  expect(job().subagents_max_total).toBe(7)
  expect(jobLimitFor(db.sqlite, 'job-1')).toBeNull()
})

test('allowing more starts from where the job stands when it passed its total', () => {
  db.tx((sqlite) => {
    changeJobSubagents(sqlite, 'job-1', { maxTotal: 2 })
    sqlite.prepare("UPDATE jobs SET subagents_used = 6 WHERE id = 'job-1'").run()
    allowMoreSubagents(sqlite, 'job-1', 3)
  })
  expect(job().subagents_max_total).toBe(9)
})

test('a run’s limits are the job it was started as', () => {
  db.tx((sqlite) =>
    sqlite
      .prepare(
        "UPDATE jobs SET recipe_kind = 'orchestration', recipe_ref = 'orc-1', subagents_used = 20 WHERE id = 'job-1'",
      )
      .run(),
  )
  expect(runJobScope(db.sqlite, 'orc-1')).toEqual({ jobId: 'job-1' })
  expect(runSubagentTotalReached(db.sqlite, 'orc-1')).toBe(true)
  expect(runJobScope(db.sqlite, 'orc-other')).toEqual({})
})

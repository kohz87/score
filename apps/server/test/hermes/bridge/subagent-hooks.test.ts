import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import { subagentRowsOf } from '../../../src/domain/subagent-rows.ts'
import { rememberSubagentSession } from '../../../src/domain/subagents.ts'
import { applySubagentHook } from '../../../src/hermes/bridge/translate-subagents.ts'

let dir: string
let db: ScoreDb
const producer = { profile: 'lead' }
const NOW = '2026-11-09T12:00:00.000Z'
const start = (child: string, parent = 'score-1') =>
  db.tx((sqlite) =>
    applySubagentHook(
      sqlite,
      'subagent_start',
      { parent_session_id: parent, child_session_id: child, child_goal: 'Read the feed API' },
      producer,
      NOW,
    ),
  )
const stop = (child: string, status: string) =>
  db.tx((sqlite) =>
    applySubagentHook(
      sqlite,
      'subagent_stop',
      { child_session_id: child, child_status: status },
      producer,
      NOW,
    ),
  )
const used = () =>
  (
    db.sqlite.prepare("SELECT subagents_used AS n FROM jobs WHERE id = 'job-1'").get() as {
      n: number
    }
  ).n

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-subagent-hooks-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
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
    rememberSubagentSession(sqlite, 'score-1', 'lead', 'job-1', true)
  })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a start counts and adds a row; a stop closes it', () => {
  const started = start('child-1')
  expect(started.map((draft) => draft.type)).toEqual(['subagents.changed', 'subagent.upserted'])
  expect(used()).toBe(1)
  expect(subagentRowsOf(db.sqlite, 'job-1')).toMatchObject([
    {
      id: 'child-1',
      agentId: 'lead',
      goal: 'Read the feed API',
      state: 'running',
      waitingOnYou: false,
    },
  ])
  stop('child-1', 'completed')
  expect(subagentRowsOf(db.sqlite, 'job-1')[0]).toMatchObject({ state: 'done', endedAt: NOW })
})

test('anything but success is a failure, and a late stop changes nothing', () => {
  start('child-1')
  stop('child-1', 'timeout')
  expect(subagentRowsOf(db.sqlite, 'job-1')[0]?.state).toBe('failed')
  expect(stop('child-1', 'completed')).toEqual([])
  expect(subagentRowsOf(db.sqlite, 'job-1')[0]?.state).toBe('failed')
})

test('after a compression the plugin names the session Score knows', () => {
  db.tx((sqlite) =>
    applySubagentHook(
      sqlite,
      'subagent_start',
      {
        parent_session_id: 'new-generated-id',
        policy_session_id: 'score-1',
        child_session_id: 'child-9',
        child_goal: 'Look',
      },
      producer,
      NOW,
    ),
  )
  expect(used()).toBe(1)
  expect(subagentRowsOf(db.sqlite, 'job-1')).toHaveLength(1)
})

test('a compressed child’s stop closes the row it started under', () => {
  start('child-1')
  db.tx((sqlite) =>
    applySubagentHook(
      sqlite,
      'subagent_stop',
      {
        child_session_id: 'child-tip',
        child_root_session_id: 'child-1',
        child_status: 'completed',
      },
      producer,
      NOW,
    ),
  )
  expect(subagentRowsOf(db.sqlite, 'job-1')[0]?.state).toBe('done')
})

test('a replayed start doesn’t count twice', () => {
  start('child-1')
  expect(start('child-1')).toEqual([])
  expect(used()).toBe(1)
})

test('a session Score has no job for is left out', () => {
  expect(start('child-1', 'outside')).toEqual([])
  expect(used()).toBe(0)
  expect(subagentRowsOf(db.sqlite, 'job-1')).toEqual([])
})

test('a secret in a goal is redacted', () => {
  db.tx((sqlite) =>
    applySubagentHook(
      sqlite,
      'subagent_start',
      {
        parent_session_id: 'score-1',
        child_session_id: 'child-2',
        child_goal: 'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      },
      producer,
      NOW,
    ),
  )
  expect(subagentRowsOf(db.sqlite, 'job-1')[0]?.goal).not.toContain('abcdefghijklmnop')
})

test('malformed payloads do nothing', () => {
  db.tx((sqlite) => {
    expect(applySubagentHook(sqlite, 'subagent_start', {}, producer, NOW)).toEqual([])
    expect(
      applySubagentHook(sqlite, 'subagent_stop', { child_session_id: 7 }, producer, NOW),
    ).toEqual([])
  })
})

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

// PLAN 11.11a: migration 0086 moves the rooms people talk in to exchanges; run rooms keep mentions.
const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
const MIGRATION = '0086_rooms_route_with_exchanges.sql'
const at = '2026-10-24T00:00:00.000Z'
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-rooms-ex-mig-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function migrateBefore() {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations)
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.sql')))
    if (name < '0086') copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
  return migrations
}
const room = (id: string, kind: 'room' | 'direct', role: 'room' | 'direct' | 'team') =>
  db.sqlite
    .prepare(
      'INSERT INTO rooms (id, name, kind, role, lead_agent_id, members, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    )
    .run(id, `name-${id}`, kind, role, JSON.stringify(['builder']), at, at)
const runRoom = (id: string, planner: 'lead' | 'workflow') =>
  db.sqlite
    .prepare(
      `INSERT INTO orchestrations (id, title, goal, planner, lead_agent_id, lead_incarnation, allowed_agents, room_id,
         brief_id, gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd,
         step_estimate_usd, status, acknowledgement, preflight, reserve_bytes, created_at, updated_at)
       VALUES (?, 't', 'g', ?, ?, ?, '[]', ?, ?, 'none', 5, 5, 1, 0, 0, 'running', '{}', '{}', 0, ?, ?)`,
    )
    .run(
      `orc-${id}`,
      planner,
      planner === 'lead' ? 'lead' : null,
      planner === 'lead' ? 'inc' : null,
      id,
      `brief-${id}`,
      at,
      at,
    )
const message = (id: string, roomId: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       VALUES (?, ?, 'you', NULL, '[]', '[{"kind":"text","text":"hi"}]', '[]', 0, ?, ?)`,
    )
    .run(id, roomId, at, at)
const routing = () =>
  Object.fromEntries(
    (
      db.sqlite.prepare('SELECT id, routing FROM rooms').all() as { id: string; routing: string }[]
    ).map((row) => [row.id, row.routing]),
  )
const snapshot = () => ({
  messages: db.sqlite.prepare('SELECT * FROM messages ORDER BY id').all(),
  jobs: db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all(),
  jobSessions: db.sqlite.prepare('SELECT * FROM job_sessions ORDER BY job_id, agent_id').all(),
  jobReads: db.sqlite.prepare('SELECT * FROM job_reads ORDER BY job_id').all(),
})

test('0086 moves rooms people talk in to exchanges and leaves run rooms and the team room alone', () => {
  const migrations = migrateBefore()
  db.sqlite.exec('PRAGMA foreign_keys = OFF') // the run rows need no brief for this test
  room('plain', 'room', 'room')
  room('chat', 'direct', 'direct')
  room('orc', 'room', 'room')
  room('wf', 'room', 'room')
  room('team', 'room', 'team')
  runRoom('orc', 'lead')
  runRoom('wf', 'workflow')
  for (const id of ['plain', 'chat', 'orc', 'wf', 'team']) message(`m-${id}`, id)
  const plainJob = (
    db.sqlite.prepare("SELECT id FROM jobs WHERE room_id = 'plain' AND is_default = 1").get() as {
      id: string
    }
  ).id
  db.sqlite
    .prepare(
      "INSERT INTO job_sessions (job_id, agent_id, session_id, created_at) VALUES (?, 'builder', 'score-plain-builder', ?)",
    )
    .run(plainJob, at)
  db.sqlite
    .prepare(
      "INSERT INTO job_reads (job_id, last_read_message_created_at, last_read_message_id) VALUES (?, ?, 'm-plain')",
    )
    .run(plainJob, at)
  expect(Object.values(routing())).toEqual(Array(5).fill('mentions'))
  const before = snapshot()
  const sessionsBefore = db.sqlite
    .prepare(
      'SELECT room_id, session_scheme, is_default FROM jobs WHERE is_default = 1 ORDER BY room_id',
    )
    .all()

  copyFileSync(join(SRC, MIGRATION), join(migrations, MIGRATION))
  migrate(db, migrations)

  expect(routing()).toEqual({
    plain: 'exchanges',
    chat: 'exchanges',
    orc: 'mentions',
    wf: 'mentions',
    team: 'mentions',
  })
  expect(snapshot()).toEqual(before)
  expect(
    db.sqlite
      .prepare(
        'SELECT room_id, session_scheme, is_default FROM jobs WHERE is_default = 1 ORDER BY room_id',
      )
      .all(),
  ).toEqual(sessionsBefore)
  expect(
    db.sqlite.prepare('SELECT session_id FROM job_sessions WHERE job_id = ?').all(plainJob),
  ).toEqual([{ session_id: 'score-plain-builder' }])
  expect(
    (
      db.sqlite.prepare('SELECT session_scheme FROM jobs WHERE id = ?').get(plainJob) as {
        session_scheme: string
      }
    ).session_scheme,
  ).toBe('room')

  // Running the statement again changes nothing.
  const after = routing()
  db.sqlite.exec(readFileSync(join(SRC, MIGRATION), 'utf8'))
  expect(routing()).toEqual(after)
  expect(snapshot()).toEqual(before)
})

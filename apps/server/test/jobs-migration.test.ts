import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import {
  defaultJobId,
  ensureJobSession,
  roomSession,
  sessionFor,
  sessionOwner,
} from '../src/domain/job-sessions.ts'
import { deleteRoom } from '../src/domain/room-delete.ts'

// PLAN 11.1a: every room gets one default job; messages and turns belong to it; sessions resolve in one place.
const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
const SERVER_SRC = fileURLToPath(new URL('../src/', import.meta.url))
const at = '2026-10-24T00:00:00.000Z'
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-jobs-mig-'))
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
    if (name < '0080') copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
  return migrations
}
function upgrade(migrations: string) {
  copyFileSync(join(SRC, '0080_jobs.sql'), join(migrations, '0080_jobs.sql'))
  migrate(db, migrations)
}
const room = (id: string, name: string, kind: 'room' | 'direct', lead: string, members: string[]) =>
  db.sqlite
    .prepare(
      'INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, kind, lead, JSON.stringify(members), at, at)
const message = (id: string, roomId: string, createdAt = at) =>
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       VALUES (?, ?, 'you', NULL, '[]', '[{"kind":"text","text":"hi"}]', '[]', 0, ?, ?)`,
    )
    .run(id, roomId, createdAt, createdAt)
const turn = (messageId: string, roomId: string, agentId: string, parent: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, 'hi', '[]', ?)`,
    )
    .run(messageId, roomId, agentId, parent, `turn-${messageId}`, parent, at)
const jobOf = (table: 'messages' | 'message_runs', column: string, id: string) =>
  (
    db.sqlite.prepare(`SELECT job_id FROM ${table} WHERE ${column} = ?`).get(id) as {
      job_id: string | null
    }
  ).job_id

test('0080 gives every existing room one default job holding all its messages and turns', () => {
  const migrations = migrateBefore()
  room('r1', 'release', 'room', 'lead', ['lead', 'builder'])
  room('d1', 'builder', 'direct', 'builder', ['builder'])
  message('m1', 'r1')
  message('m2', 'r1')
  message('m3', 'd1')
  turn('reply:1', 'r1', 'builder', 'm1')
  upgrade(migrations)

  const jobs = db.sqlite
    .prepare('SELECT room_id, title, session_scheme, is_default, state FROM jobs ORDER BY room_id')
    .all()
  expect(jobs).toEqual([
    { room_id: 'd1', title: 'builder', session_scheme: 'room', is_default: 1, state: 'open' },
    { room_id: 'r1', title: 'release', session_scheme: 'room', is_default: 1, state: 'open' },
  ])
  const r1 = defaultJobId(db.sqlite, 'r1')!
  expect(jobOf('messages', 'id', 'm1')).toBe(r1)
  expect(jobOf('messages', 'id', 'm2')).toBe(r1)
  expect(jobOf('messages', 'id', 'm3')).toBe(defaultJobId(db.sqlite, 'd1'))
  expect(jobOf('message_runs', 'message_id', 'reply:1')).toBe(r1)
  expect(db.sqlite.prepare('SELECT id, role, routing FROM rooms ORDER BY id').all()).toEqual([
    { id: 'd1', role: 'direct', routing: 'mentions' },
    { id: 'r1', role: 'room', routing: 'mentions' },
  ])
  expect(
    db.sqlite.prepare('SELECT count(*) AS n FROM messages WHERE job_id IS NULL').get(),
  ).toEqual({
    n: 0,
  })
})

test('running the migrations again changes nothing', () => {
  const migrations = migrateBefore()
  room('r1', 'release', 'room', 'lead', ['lead'])
  message('m1', 'r1')
  upgrade(migrations)
  const jobs = db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all()
  migrate(db, migrations)
  expect(db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all()).toEqual(jobs)
  expect(jobOf('messages', 'id', 'm1')).toBe(defaultJobId(db.sqlite, 'r1'))
})

test('a migrated room keeps its exact session ids, continued outside sessions included', () => {
  const migrations = migrateBefore()
  room('r1', 'release', 'room', 'lead', ['lead', 'builder'])
  room('r2', 'imported', 'room', 'lead', ['lead'])
  db.sqlite
    .prepare(
      "INSERT INTO room_sessions (room_id, agent_id, session_id, mode) VALUES ('r2', 'lead', 'tg-123', 'same_session')",
    )
    .run()
  upgrade(migrations)
  expect(roomSession(db.sqlite, 'r1', 'builder')).toBe('score-r1-builder')
  expect(roomSession(db.sqlite, 'r2', 'lead')).toBe('tg-123')
  // A turn row without a job falls back to its room's session.
  expect(sessionFor(db.sqlite, { roomId: 'r1', jobId: null, agentId: 'lead' })).toBe(
    'score-r1-lead',
  )
  expect(sessionOwner(db.sqlite, 'builder', 'score-r1-builder')).toEqual({
    roomId: 'r1',
    jobId: defaultJobId(db.sqlite, 'r1'),
    continued: false,
  })
  expect(sessionOwner(db.sqlite, 'lead', 'tg-123')).toMatchObject({ roomId: 'r2', continued: true })
  expect(sessionOwner(db.sqlite, 'lead', 'score-nope-lead')).toBeNull()
  expect(sessionOwner(db.sqlite, 'lead', 'other')).toBeNull()
})

test('after 0080, new rooms, messages and turns get their job by trigger', () => {
  upgrade(migrateBefore())
  room('r9', 'new', 'room', 'lead', ['lead', 'builder'])
  room('d9', 'designer', 'direct', 'designer', ['designer'])
  const job = defaultJobId(db.sqlite, 'r9')
  expect(job).toMatch(/^job_[0-9a-f]{24}$/)
  expect(db.sqlite.prepare("SELECT role FROM rooms WHERE id = 'd9'").get()).toEqual({
    role: 'direct',
  })
  message('m9', 'r9')
  expect(jobOf('messages', 'id', 'm9')).toBe(job)
  turn('reply:9', 'r9', 'builder', 'm9')
  expect(jobOf('message_runs', 'message_id', 'reply:9')).toBe(job)
})

test('a turn answers into the job of its message, and job-scheme sessions resolve both ways', () => {
  upgrade(migrateBefore())
  room('r1', 'release', 'room', 'lead', ['lead', 'builder'])
  db.sqlite
    .prepare(
      "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES ('job_x', 'r1', 'Activity feed', 'job', ?, ?)",
    )
    .run(at, at)
  db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, job_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       VALUES ('mx', 'r1', 'job_x', 'you', NULL, '[]', '[]', '[]', 0, ?, ?)`,
    )
    .run(at, at)
  turn('reply:x', 'r1', 'builder', 'mx')
  expect(jobOf('message_runs', 'message_id', 'reply:x')).toBe('job_x')
  const turnInJob = { roomId: 'r1', jobId: 'job_x', agentId: 'builder' }
  expect(sessionFor(db.sqlite, turnInJob)).toBe('score-r1-job_x-builder')
  // Not recorded yet: the reverse lookup doesn't guess (the room key parse would misread it).
  expect(sessionOwner(db.sqlite, 'builder', 'score-r1-job_x-builder')).toBeNull()
  ensureJobSession(db.sqlite, 'job_x', 'builder', at)
  ensureJobSession(db.sqlite, 'job_x', 'builder', at)
  expect(sessionOwner(db.sqlite, 'builder', 'score-r1-job_x-builder')).toEqual({
    roomId: 'r1',
    jobId: 'job_x',
    continued: false,
  })
  // The default job never records a session: its session is the room's.
  ensureJobSession(db.sqlite, defaultJobId(db.sqlite, 'r1')!, 'builder', at)
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM job_sessions').get()).toEqual({ n: 1 })
  // At most one default job per room, and a default job keeps the room's sessions.
  expect(() =>
    db.sqlite
      .prepare(
        "INSERT INTO jobs (id, room_id, title, session_scheme, is_default, created_at, updated_at) VALUES ('job_y', 'r1', 'x', 'room', 1, ?, ?)",
      )
      .run(at, at),
  ).toThrow()
  room('r3', 'empty', 'room', 'lead', ['lead'])
  db.sqlite.prepare("DELETE FROM jobs WHERE room_id = 'r3'").run()
  expect(() =>
    db.sqlite
      .prepare(
        "INSERT INTO jobs (id, room_id, title, session_scheme, is_default, created_at, updated_at) VALUES ('job_z', 'r3', 'x', 'job', 1, ?, ?)",
      )
      .run(at, at),
  ).toThrow(/CHECK/)
})

test('deleting a room removes its jobs and job sessions', () => {
  upgrade(migrateBefore())
  room('r1', 'release', 'room', 'lead', ['lead', 'builder'])
  message('m1', 'r1')
  db.sqlite
    .prepare(
      "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES ('job_x', 'r1', 'x', 'job', ?, ?)",
    )
    .run(at, at)
  ensureJobSession(db.sqlite, 'job_x', 'builder', at)
  db.tx((sqlite) => deleteRoom(sqlite, 'r1', 'release', at))
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 })
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM job_sessions').get()).toEqual({ n: 0 })
})

test('no Score session id is built outside domain/job-sessions.ts', () => {
  // Known `score-${…}` templates that are not session ids: export file names, a pairing label, coding unit names.
  const allowed = new Map([
    ['http/conversations.ts', 1],
    ['hermes/live/settings.ts', 1],
    ['runtimes/coding/units.ts', 1],
    ['domain/job-sessions.ts', 2],
  ])
  const found = new Map<string, number>()
  const quoted: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8')
        const count = text.split('`score-${').length - 1
        if (count) found.set(relative(SERVER_SRC, path), count)
        // Concatenation or parsing (`'score-' + room`, `startsWith('score-')`) may only happen in the resolver.
        if (/['"]score-['"]/.test(text)) quoted.push(relative(SERVER_SRC, path))
      }
    }
  }
  walk(SERVER_SRC)
  expect(Object.fromEntries(found)).toEqual(Object.fromEntries(allowed))
  expect(quoted).toEqual(['domain/job-sessions.ts'])
})

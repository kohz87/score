import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import {
  currentSession,
  isSuccessorSession,
  retireSession,
  roomSession,
  sessionOwner,
} from '../src/domain/job-sessions.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-sessions-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  const at = '2026-10-26T00:00:00.000Z'
  db.sqlite
    .prepare(
      "INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at) VALUES ('r1', 'one', 'room', 'lead', '[\"lead\",\"builder\"]', ?, ?)",
    )
    .run(at, at)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// 2.3.0 (decision 128): a session Hermes deleted is replaced by a successor; ids and owners follow it.
test('a retired session id gets successors ~2, ~3 that the room uses and that still belong to the room', () => {
  const sqlite = db.sqlite
  const base = roomSession(sqlite, 'r1', 'builder')
  expect(base).toBe('score-r1-builder')
  expect(retireSession(sqlite, 'builder', base, 'now')).toBe(`${base}~2`)
  expect(retireSession(sqlite, 'builder', base, 'now')).toBe(`${base}~2`)
  expect(roomSession(sqlite, 'r1', 'builder')).toBe(`${base}~2`)
  expect(retireSession(sqlite, 'builder', `${base}~2`, 'now')).toBe(`${base}~3`)
  expect(currentSession(sqlite, 'builder', base)).toBe(`${base}~3`)
  expect(isSuccessorSession(sqlite, 'builder', base)).toBe(false)
  expect(isSuccessorSession(sqlite, 'builder', `${base}~3`)).toBe(true)
  expect(sessionOwner(sqlite, 'builder', `${base}~3`)).toMatchObject({ roomId: 'r1' })
  // Another agent's sessions are untouched.
  expect(roomSession(sqlite, 'r1', 'reviewer')).toBe('score-r1-reviewer')
})

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import {
  defaultJobId,
  ensureJobSession,
  sessionFor,
  sessionOwner,
} from '../src/domain/job-sessions.ts'
import { insertRoom } from '../src/domain/rooms.ts'
import { ensureTeamRoom, teamRoomId } from '../src/domain/team-room.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../src/runtimes/coding/service.ts'
import { cliSessionFor, rememberCliSession } from '../src/runtimes/coding/store.ts'

// PLAN 11.1b: coding CLI sessions and Score session lookup are per (job, agent), and the team room is one room.
const at = (second: number) => new Date(Date.UTC(2026, 9, 24, 11, 0, second)).toISOString()
const ROOM = 'r1'
const SECOND_JOB = 'job_second'
let dir: string
let db: ScoreDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-scope-sessions-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  insertRoom(
    db.sqlite,
    {
      id: ROOM,
      name: '#release',
      kind: 'room',
      leadAgentId: 'lead',
      members: ['lead', 'builder', 'reviewer'],
    },
    at(0),
  )
  db.sqlite
    .prepare(
      "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES (?, ?, 'Side thread', 'job', ?, ?)",
    )
    .run(SECOND_JOB, ROOM, at(0), at(0))
  for (const agentId of ['lead', 'builder', 'reviewer'])
    db.sqlite
      .prepare(
        "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready')",
      )
      .run(agentId, randomUUID())
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('coding CLI sessions are per job and forgetting one Score key forgets one job only', () => {
  const job = defaultJobId(db.sqlite, ROOM)!
  rememberCliSession(db.sqlite, job, 'builder', 'cli-default', at(1))
  rememberCliSession(db.sqlite, SECOND_JOB, 'builder', 'cli-second', at(1))
  rememberCliSession(db.sqlite, SECOND_JOB, 'reviewer', 'cli-reviewer', at(1))
  ensureJobSession(db.sqlite, SECOND_JOB, 'builder', at(1))
  const secondKey = sessionFor(db.sqlite, {
    roomId: ROOM,
    jobId: SECOND_JOB,
    agentId: 'builder',
  })
  expect(secondKey).toBe('score-r1-job_second-builder')
  expect(cliSessionFor(db.sqlite, SECOND_JOB, 'builder')).toBe('cli-second')

  const coding = new CodingRuntime({ db } as unknown as CodingRuntimeDeps)
  coding.forgetRoomSession(secondKey, 'builder')

  expect(cliSessionFor(db.sqlite, SECOND_JOB, 'builder')).toBeNull()
  expect(cliSessionFor(db.sqlite, job, 'builder')).toBe('cli-default')
  expect(cliSessionFor(db.sqlite, SECOND_JOB, 'reviewer')).toBe('cli-reviewer')
})

test('sessionOwner resolves an unrecorded job key and rejects an unknown job id', () => {
  expect(sessionOwner(db.sqlite, 'builder', 'score-r1-job_second-builder')).toEqual({
    roomId: ROOM,
    jobId: SECOND_JOB,
    continued: false,
  })
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM job_sessions').get()).toEqual({ n: 0 })
  expect(sessionOwner(db.sqlite, 'builder', 'score-r1-job_missing-builder')).toBeNull()
})

test('ensureTeamRoom creates one exchanges room with sorted members and no guessed lead', () => {
  const drafts = ensureTeamRoom(db.sqlite, ['reviewer', 'lead', 'lead'], at(1))
  const id = teamRoomId(db.sqlite)!
  expect(drafts).toHaveLength(1)
  expect(drafts[0]).toMatchObject({
    type: 'room.upserted',
    data: {
      id,
      role: 'team',
      routing: 'exchanges',
      leadAgentId: null,
      members: ['lead', 'reviewer'],
    },
  })
  expect(db.sqlite.prepare("SELECT count(*) AS n FROM rooms WHERE role = 'team'").get()).toEqual({
    n: 1,
  })
  expect(ensureTeamRoom(db.sqlite, ['lead', 'reviewer'], at(2))).toEqual([])
  expect(db.sqlite.prepare("SELECT count(*) AS n FROM rooms WHERE role = 'team'").get()).toEqual({
    n: 1,
  })
})

test('the team room takes the next free name when “Team room” is taken', () => {
  insertRoom(
    db.sqlite,
    { id: 'old', name: 'Team room', kind: 'room', leadAgentId: 'lead', members: ['lead'] },
    at(0),
  )
  ensureTeamRoom(db.sqlite, ['lead'], at(1))
  expect(db.sqlite.prepare("SELECT name FROM rooms WHERE role = 'team'").get()).toEqual({
    name: 'Team room 2',
  })
})

test('an empty agent list changes nothing; a changed list updates members once', () => {
  expect(ensureTeamRoom(db.sqlite, [], at(1))).toEqual([])
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 1 })

  ensureTeamRoom(db.sqlite, ['lead', 'builder'], at(2))
  const id = teamRoomId(db.sqlite)!
  const changed = ensureTeamRoom(db.sqlite, ['reviewer', 'builder'], at(3))
  expect(changed).toHaveLength(1)
  expect(changed[0]).toMatchObject({
    type: 'room.upserted',
    data: { id, members: ['builder', 'reviewer'] },
  })
  expect(db.sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(id)).toEqual({
    members: '["builder","reviewer"]',
  })
})

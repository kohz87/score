import { RoomSchema, TeamRoomsResponseSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ensureTeamRoom, syncTeamRoomMembers, teamRoomId } from '../../src/domain/team-room.ts'
import { retireAgentFromRooms } from '../../src/domain/rooms.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// 3.4.0 (decision 136): team rooms of chosen agents next to the everyone team room.

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let keys = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-team-rooms-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false)
  await port.start(ingest)
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  await ingest.submit({
    source: 'test',
    identity: 'team-room',
    apply: ({ sqlite, now }) =>
      ensureTeamRoom(sqlite, ['lead', 'builder', 'reviewer', 'designer'], now),
  })
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': `k${++keys}` }) },
    ...(payload ? { payload } : {}),
  })

const createTeam = (payload: object) => call('POST', '/api/team-rooms', payload)

test('a team of chosen agents is a team room next to the everyone room', async () => {
  const created = await createTeam({
    name: 'Docs team',
    members: ['builder', 'reviewer'],
    leadAgentId: 'reviewer',
  })
  expect(created.statusCode).toBe(201)
  const team = RoomSchema.parse(created.json())
  expect(team).toMatchObject({
    role: 'team',
    everyone: false,
    routing: 'exchanges',
    members: ['builder', 'reviewer'],
    leadAgentId: 'reviewer',
  })
  const list = TeamRoomsResponseSchema.parse((await call('GET', '/api/team-rooms')).json())
  expect(list.items.map((room) => [room.name, room.everyone])).toEqual([
    ['Team room', true],
    ['Docs team', false],
  ])
  // It has its own default job, so jobs can start there.
  const job = await call('POST', `/api/rooms/${team.id}/jobs`, { title: 'Write the docs' })
  expect(job.statusCode).toBeLessThan(300)
  // The everyone room is still the one `/api/team-room` and the roster sync mean.
  expect(db.read((sqlite) => teamRoomId(sqlite))).toBe(list.items[0]!.id)
})

test('creating a team checks its lead, its members and its name', async () => {
  expect(
    (await createTeam({ name: 'A', members: ['builder'], leadAgentId: 'reviewer' })).statusCode,
  ).toBe(400)
  expect((await createTeam({ name: 'A', members: [], leadAgentId: 'builder' })).statusCode).toBe(
    400,
  )
  expect(
    (await createTeam({ name: 'A', members: ['nobody'], leadAgentId: 'nobody' })).statusCode,
  ).toBe(400)
  expect(
    (await createTeam({ name: 'Team room', members: ['builder'], leadAgentId: 'builder' }))
      .statusCode,
  ).toBe(409)
})

test('a chosen team can be renamed, re-membered, archived and deleted; the everyone room cannot', async () => {
  const team = RoomSchema.parse(
    (await createTeam({ name: 'Ops', members: ['builder', 'lead'], leadAgentId: 'lead' })).json(),
  )
  const renamed = await call('PATCH', `/api/rooms/${team.id}`, { name: 'Ops team' })
  expect(renamed.statusCode, renamed.body).toBe(200)
  expect(
    (await call('PATCH', `/api/rooms/${team.id}`, { members: ['builder', 'lead', 'designer'] }))
      .statusCode,
  ).toBe(200)
  // The lead must stay a member, and a team keeps at least one.
  expect((await call('PATCH', `/api/rooms/${team.id}`, { members: ['builder'] })).statusCode).toBe(
    400,
  )
  expect((await call('PATCH', `/api/rooms/${team.id}`, { members: [] })).statusCode).toBe(400)
  expect((await call('PATCH', `/api/rooms/${team.id}`, { archived: true })).statusCode).toBe(200)
  const everyone = db.read((sqlite) => teamRoomId(sqlite))!
  expect((await call('PATCH', `/api/rooms/${everyone}`, { name: 'Renamed' })).statusCode).toBe(409)
  expect(
    (await call('DELETE', `/api/rooms/${everyone}`, { confirm: 'Team room' })).statusCode,
  ).toBe(409)
  expect((await call('DELETE', `/api/rooms/${team.id}`, { confirm: 'Ops team' })).statusCode).toBe(
    204,
  )
})

test('the roster sync keeps only the everyone room in step; a departing agent leaves every team', async () => {
  const team = RoomSchema.parse(
    (
      await createTeam({ name: 'Pair', members: ['builder', 'reviewer'], leadAgentId: 'builder' })
    ).json(),
  )
  await ingest.submit({
    source: 'test',
    identity: 'sync',
    apply: ({ sqlite, now }) => syncTeamRoomMembers(sqlite, now),
  })
  const after = () =>
    db.read((sqlite) =>
      JSON.parse(
        (
          sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(team.id) as {
            members: string
          }
        ).members,
      ),
    )
  expect(after()).toEqual(['builder', 'reviewer'])
  await ingest.submit({
    source: 'test',
    identity: 'retire',
    apply: ({ sqlite, now }) => retireAgentFromRooms(sqlite, 'builder', now),
  })
  expect(after()).toEqual(['reviewer'])
  const room = RoomSchema.parse((await call('GET', `/api/rooms/${team.id}`)).json().room)
  expect(room.leadAgentId).toBeNull()
})

test('migration 0091 allows one everyone room only', () => {
  expect(() =>
    db.sqlite
      .prepare(
        "INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, team_everyone) VALUES ('x', 'Second everyone', 'room', '[]', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', 'team', 1)",
      )
      .run(),
  ).toThrow(/UNIQUE/)
})

test('a member that is briefly not ready stays while the person changes the others (review)', async () => {
  const team = RoomSchema.parse(
    (
      await createTeam({ name: 'Mixed', members: ['builder', 'reviewer'], leadAgentId: 'reviewer' })
    ).json(),
  )
  db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, operation_id, display_name) VALUES ('builder', '00000000-0000-4000-8000-000000000001', 'needs_attention', NULL, NULL)",
    )
    .run()
  const kept = await call('PATCH', `/api/rooms/${team.id}`, {
    members: ['builder', 'reviewer', 'designer'],
  })
  expect(kept.statusCode, kept.body).toBe(200)
  // A not-ready agent still can't join.
  db.sqlite.prepare("UPDATE agent_lifecycle SET agent_id = 'lead' WHERE agent_id = 'builder'").run()
  expect(
    (await call('PATCH', `/api/rooms/${team.id}`, { members: ['builder', 'reviewer', 'lead'] }))
      .statusCode,
  ).toBe(400)
})

test('an ordinary room keeps its #name rule; a team keeps plain names', async () => {
  const room = await call('POST', '/api/rooms', { name: 'ops' })
  expect(room.statusCode).toBe(200)
  expect(
    (await call('PATCH', `/api/rooms/${room.json().id}`, { name: 'Not A Slug' })).statusCode,
  ).toBe(400)
})

test('a team whose jobs have Workbench review notes can be deleted (3.6.0)', async () => {
  const team = RoomSchema.parse(
    (
      await createTeam({ name: 'Reviewers', members: ['reviewer'], leadAgentId: 'reviewer' })
    ).json(),
  )
  const job = db.sqlite.prepare('SELECT id FROM jobs WHERE room_id = ?').get(team.id) as {
    id: string
  }
  db.sqlite
    .prepare(
      "INSERT INTO review_comments (id, job_id, turn_id, agent_id, action, path, line, text, created_at) VALUES ('rc1', ?, 't1', 'reviewer', 'review', 'src/a.ts', 3, 'Check this', '2026-10-26T10:00:00.000Z')",
    )
    .run(job.id)
  const deleted = await call('DELETE', `/api/rooms/${team.id}`, { confirm: 'Reviewers' })
  expect(deleted.statusCode, deleted.body).toBe(204)
  expect(db.sqlite.prepare("SELECT 1 FROM review_comments WHERE id = 'rc1'").get()).toBeUndefined()
})

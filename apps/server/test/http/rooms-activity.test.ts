import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { refreshRooms } from '../../src/domain/rooms.ts'
import { createRoomsTestHelpers, setupRoomsTest, type RoomsTestState } from './rooms-helpers.ts'

let dir: RoomsTestState['dir']
let db: RoomsTestState['db']
let ingest: RoomsTestState['ingest']
let port: RoomsTestState['port']
let scheduler: RoomsTestState['scheduler']
let app: RoomsTestState['app']
let headers: RoomsTestState['headers']
const testState: RoomsTestState = {
  get dir() {
    return dir
  },
  set dir(value) {
    dir = value
  },
  get db() {
    return db
  },
  set db(value) {
    db = value
  },
  get ingest() {
    return ingest
  },
  set ingest(value) {
    ingest = value
  },
  get port() {
    return port
  },
  set port(value) {
    port = value
  },
  get scheduler() {
    return scheduler
  },
  set scheduler(value) {
    scheduler = value
  },
  get app() {
    return app
  },
  set app(value) {
    app = value
  },
  get headers() {
    return headers
  },
  set headers(value) {
    headers = value
  },
  counter: 0,
}

const { create, events } = createRoomsTestHelpers(testState)
setupRoomsTest(testState)

test('an approval that expires while idle clears its agent on the periodic sweep', async () => {
  const room = await create()
  const at = new Date(scheduler.now()).toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash,
        token_expires_at, created_at, last_seen_at, gateway_approvals)
       VALUES ('p1', 'builder', 'inc', 1, 'host', '1', '{}', 'hash', 0, ?, ?, 1)`,
    )
    .run(at, new Date(scheduler.now() + 3_600_000).toISOString())
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, request_id, producer_id, profile, session_key, surface,
        command, description, pattern_keys, choices, phase, status, created_at, expires_at, updated_at)
       VALUES ('a1', 'gateway', 'human', 'gateway_request', 'req', 'p1', 'builder', 's', 'cli', 'rm', 'd', '[]',
        '["once"]', 'human_pending', 'pending', ?, ?, ?)`,
    )
    .run(at, new Date(scheduler.now() + 300_000).toISOString(), at)
  await app.close()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      db,
      ingest,
      port,
      clock: () => scheduler.now(),
    })
    await ingest.submit({
      source: 'test',
      identity: 'initial',
      apply: ({ sqlite, now }) => refreshRooms(sqlite, now),
    })
    expect(events().at(-1)).toMatchObject({ data: { id: room.id, activeAgents: ['builder'] } })
    await scheduler.advance(600000)
    const count = events().length
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count + 1)
    expect(events().at(-1)).toMatchObject({
      type: 'room.upserted',
      data: { id: room.id, activeAgents: [] },
    })
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count + 1)
    await app.close()
  } finally {
    vi.useRealTimers()
  }
})

test('a compatibility change that switches approvals off clears their agents on the next sweep', async () => {
  const room = await create()
  const at = new Date(scheduler.now()).toISOString()
  db.sqlite
    .prepare(
      `INSERT INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash,
        token_expires_at, created_at, last_seen_at, gateway_approvals)
       VALUES ('p1', 'builder', 'inc', 1, 'host', '1', '{}', 'hash', 0, ?, ?, 1)`,
    )
    .run(at, new Date(scheduler.now() + 3_600_000).toISOString())
  db.sqlite
    .prepare(
      `INSERT INTO approvals (id, origin, stage, target_kind, request_id, producer_id, profile, session_key, surface,
        command, description, pattern_keys, choices, phase, status, created_at, updated_at)
       VALUES ('a1', 'gateway', 'human', 'gateway_request', 'req', 'p1', 'builder', 's', 'cli', 'rm', 'd', '[]',
        '["once"]', 'human_pending', 'pending', ?, ?)`,
    )
    .run(at, at)
  await app.close()
  const status = port.status()
  let disabled: string[] = []
  vi.spyOn(port, 'status').mockImplementation(() => ({
    ...status,
    compatibility: { ...status.compatibility, disabled },
  }))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    app = buildApp({
      config: loadConfig({ SCORE_MODE: 'fake' }),
      logger: false,
      db,
      ingest,
      port,
      clock: () => scheduler.now(),
    })
    await ingest.submit({
      source: 'test',
      identity: 'initial',
      apply: ({ sqlite, now }) => refreshRooms(sqlite, now),
    })
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    const count = events().length
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count)
    expect(events().at(-1)).toMatchObject({ data: { activeAgents: ['builder'] } })
    disabled = ['gateway-approvals']
    await vi.advanceTimersByTimeAsync(30000)
    await ingest.drain()
    expect(events()).toHaveLength(count + 1)
    expect(events().at(-1)).toMatchObject({
      type: 'room.upserted',
      data: { id: room.id, activeAgents: [] },
    })
    await app.close()
  } finally {
    vi.useRealTimers()
  }
})

test('rooms migration enforces STRICT tables, valid JSON, author constraints and indexed paging', () => {
  const tables = z
    .array(z.object({ name: z.string(), strict: z.int() }))
    .parse(db.sqlite.prepare('PRAGMA table_list').all())
  expect(
    tables
      .filter((table) => ['rooms', 'room_reads', 'messages'].includes(table.name))
      .every((table) => table.strict === 1),
  ).toBe(true)
  expect(
    db.sqlite
      .prepare("PRAGMA index_info('messages_room_created_id')")
      .all()
      .map((row) => row.name),
  ).toEqual(['room_id', 'created_at', 'id'])
  const now = new Date(scheduler.now()).toISOString()
  expect(() =>
    db.sqlite
      .prepare(
        'INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('bad', '#bad', 'room', 'invalid json', now, now),
  ).toThrow()
  expect(() =>
    db.sqlite.prepare('INSERT INTO room_reads VALUES (?, ?, ?)').run('missing', now, 'message'),
  ).toThrow()
})

test('an idle activity refresh creates no observation (gate review #13)', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const idle = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
  })
  try {
    const keys = () =>
      db.sqlite.prepare(`SELECT count(*) AS n FROM ingest_keys WHERE source = 'rooms'`).get()
    const before = keys()
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(keys()).toEqual(before)
  } finally {
    vi.useRealTimers()
    await idle.close()
  }
})

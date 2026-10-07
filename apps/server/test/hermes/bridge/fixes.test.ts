import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { retireIngestKeys } from '../../../src/hub/retire.ts'
import { pruneBridge } from '../../../src/hermes/bridge/retention.ts'
import { event, hello, initialTime, setup } from './helpers.ts'

let server: ReturnType<typeof setup>
beforeEach(() => {
  server = setup()
})
afterEach(async () => {
  await server.close()
})

test('review secret-key approval probe is scrubbed before reaching SQLite or the event log', async () => {
  const token = await server.token()
  expect(
    (
      await server.send(token, [
        event(1, 'pre_approval_request', {
          apiKey: 'secret-b',
          authorization: 'Basic dXNlcjpwYXNz',
          'sk-abcdefgh123456': 'key-leak',
          client_secret: { nested: 'subtree-secret' },
        }),
      ])
    ).statusCode,
  ).toBe(200)
  const row = server.db.sqlite.prepare('SELECT payload FROM approval_signals').get()!
  expect(JSON.parse(String(row.payload))).toEqual({
    apiKey: '[redacted]',
    authorization: '[redacted]',
    '[redacted]': 'key-leak',
    client_secret: '[redacted]',
  })
  const bytes = Buffer.concat(
    ['score.db', 'score.db-wal'].map((file) => readFileSync(join(server.home, file))),
  ).toString()
  for (const secret of ['secret-b', 'Basic dXNlcjpwYXNz', 'sk-abcdefgh123456', 'subtree-secret']) {
    expect(bytes).not.toContain(secret)
    expect(JSON.stringify(server.db.sqlite.prepare('SELECT * FROM events').all())).not.toContain(
      secret,
    )
  }
})

test('exact producer identity survives secret-shaped names and private API keys stay unchanged', async () => {
  const identity = {
    ...hello,
    profile: 'sk-aaaaaaaaaa',
    incarnation: 'sk-cccccccccc',
    kanbanTaskId: 'sk-taskaaaaaaaaaa',
    privateApis: { apiKey: true },
  }
  const token = await server.token(identity)
  expect((await server.handshake({ ...identity, profile: 'sk-bbbbbbbbbb' })).statusCode).toBe(409)
  expect(
    (await server.handshake({ ...identity, kanbanTaskId: 'sk-taskbbbbbbbbbb' })).statusCode,
  ).toBe(409)
  await server.token({ ...identity, incarnation: 'sk-dddddddddd' })
  expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM producers').get()).toEqual({ n: 2 })
  expect(server.db.sqlite.prepare('SELECT private_apis FROM producers LIMIT 1').get()).toEqual({
    private_apis: '{"apiKey":true}',
  })
  const identifiers = {
    sessionKey: 'sk-sessionaaaaaaaa',
    sessionId: 'sk-sessionbbbbbbbb',
    toolCallId: 'sk-toolaaaaaaaaaa',
  }
  expect(
    (
      await server.send(token, [
        { ...event(1, 'pre_tool_call', { tool_name: 'terminal' }), ...identifiers },
        {
          ...event(2, 'pre_approval_request', {
            requestId: 'sk-requestaaaaaaaa',
            sessionId: identifiers.sessionId,
          }),
          ...identifiers,
        },
      ])
    ).json(),
  ).toEqual({ ackedThrough: 2 })
  expect(
    server.db.sqlite
      .prepare('SELECT profile, session_id, tool_call_id, kanban_task_id FROM session_tool_calls')
      .get(),
  ).toEqual({
    profile: identity.profile,
    session_id: identifiers.sessionId,
    tool_call_id: identifiers.toolCallId,
    kanban_task_id: identity.kanbanTaskId,
  })
  const approval = server.db.sqlite
    .prepare('SELECT session_key, request_id, payload FROM approval_signals')
    .get()!
  expect(approval).toMatchObject({
    session_key: identifiers.sessionKey,
    request_id: 'sk-requestaaaaaaaa',
  })
  expect(JSON.parse(String(approval.payload))).toEqual({
    requestId: 'sk-requestaaaaaaaa',
    sessionId: identifiers.sessionId,
  })
})

test.each([
  { profile: 'bad profile' },
  { profile: 'é' },
  { incarnation: 'short' },
  { incarnation: 'has space' },
  { kanbanTaskId: 'bad task' },
  { privateApis: { 'sk-abcdefgh123456': true } },
])('invalid hello identity or private API key is rejected: %j', async (change) => {
  expect((await server.handshake({ ...hello, ...change })).statusCode).toBe(400)
  expect(server.db.sqlite.prepare('SELECT * FROM producers').all()).toEqual([])
})

test.each(['sessionKey', 'sessionId', 'toolCallId', 'requestId', 'request_id'])(
  'invalid %s rejects the entire batch',
  async (name) => {
    const token = await server.token()
    for (const value of ['', 'has space', '\n', 'é', 'a'.repeat(257)]) {
      const invalid = event(2, 'pre_approval_request')
      if (name.startsWith('request')) invalid.payload[name] = value
      else Object.assign(invalid, { [name]: value })
      expect((await server.send(token, [event(1), invalid])).statusCode).toBe(400)
      expect(server.db.sqlite.prepare('SELECT * FROM ingest_keys').all()).toEqual([])
    }
  },
)

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { apiKey: 'deep-secret' }
  for (let i = 0; i < depth; i++) value = { x: value }
  return value
}

test('unknown hooks acknowledge the review 2500-level probe without traversing or interpreting payloads', async () => {
  const token = await server.token()
  const events = [
    event(1, 'future_hook', nested(2500)),
    event(2, 'on_kanban_future_hook', { text: { unexpected: true }, requestId: 42 }),
  ]
  expect((await server.send(token, events)).json()).toEqual({ ackedThrough: 2 })
  expect(server.metrics.unknownHooks).toBe(2)
  expect(server.db.sqlite.prepare('SELECT * FROM events').all()).toEqual([])
  expect((await server.send(token, events)).json()).toEqual({ ackedThrough: 2 })
  expect(server.metrics.unknownHooks).toBe(2)
})

test('supported hooks bound depth and nodes, including decoded result JSON, and still ingest', async () => {
  const token = await server.token()
  expect(
    (
      await server.send(token, [
        event(1, 'pre_approval_request', nested(2500)),
        event(2, 'post_approval_response', { nodes: Array.from({ length: 10001 }, () => 0) }),
        event(3, 'post_tool_call', { result: JSON.stringify(nested(2500)) }),
        event(4, 'on_kanban_dispatch_tick'),
        event(5, 'on_kanban_worker_stale_claim'),
      ])
    ).json(),
  ).toEqual({ ackedThrough: 5 })
  expect(server.db.sqlite.prepare('SELECT payload FROM approval_signals').all()).toEqual([
    { payload: '{"omitted":"payload too complex"}' },
    { payload: '{"omitted":"payload too complex"}' },
  ])
  expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 5 })
  expect(server.metrics.unknownHooks).toBe(0)
})

test('gap-covered failures clear holds, create a contiguous checkpoint, and preserve later holds', async () => {
  const token = await server.token()
  const source = `bridge:${hello.incarnation}`
  server.db.sqlite.exec(
    "CREATE TRIGGER fail_log BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
  )
  expect((await server.send(token, [event(1)])).statusCode).toBe(500)
  expect(server.ingest.heldPositions(source, 'events')).toEqual([1])
  server.db.sqlite.exec('DROP TRIGGER fail_log')
  server.db.sqlite.prepare('DELETE FROM ingest_checkpoints WHERE source = ?').run(source)
  await expect(
    server.ingest.submit({
      source,
      identity: `${source}:4`,
      checkpoint: { scope: 'events', position: 4, incarnation: hello.incarnation },
      apply() {
        throw new Error('later failure')
      },
    }),
  ).rejects.toThrow('later failure')
  expect(
    (
      await server.send(token, [
        event(2, 'bridge.gap', { from_counter: 1, to_counter: 1, dropped: 1 }),
      ])
    ).json(),
  ).toEqual({ ackedThrough: 2 })
  expect(server.ingest.heldPositions(source, 'events')).toEqual([4])
  expect(
    server.db.sqlite
      .prepare("SELECT cursor FROM ingest_checkpoints WHERE source = ? AND scope = 'events'")
      .get(source),
  ).toEqual({ cursor: '2' })
  expect((await server.send(token, [event(3)])).json()).toEqual({ ackedThrough: 3 })
  expect(retireIngestKeys(server.db, { keepPositions: 0 }).retired).toBe(2)
  expect(server.ingest.heldPositions(source, 'events')).toEqual([4])
})

test('review disconnected gap [5,20004] never creates an orphan retirement floor', async () => {
  const token = await server.token()
  expect(
    (
      await server.send(token, [
        event(1),
        event(2),
        event(4),
        event(20005, 'bridge.gap', { from_counter: 5, to_counter: 20004, dropped: 20000 }),
      ])
    ).json(),
  ).toEqual({ ackedThrough: 2 })
  retireIngestKeys(server.db)
  expect(
    server.db.sqlite.prepare("SELECT * FROM ingest_floors WHERE scope LIKE 'gap:%'").all(),
  ).toEqual([])
  expect((await server.send(token, [event(3)])).json()).toEqual({ ackedThrough: 20005 })
  expect(
    server.db.sqlite.prepare("SELECT * FROM ingest_checkpoints WHERE scope LIKE 'gap:%'").all(),
  ).toEqual([])
  expect(
    server.db.sqlite.prepare("SELECT * FROM ingest_floors WHERE scope LIKE 'gap:%'").all(),
  ).toEqual([])
})

test('producer retention keeps unacknowledged keys and open gaps and expires eligible producers after 30 days', async () => {
  const acked = await server.token()
  await server.send(acked, [event(1)])
  const hole = await server.token({ ...hello, incarnation: 'worker-hole' })
  await server.send(hole, [event(2)])
  const gap = await server.token({ ...hello, incarnation: 'worker-gap' })
  await server.send(gap, [event(6, 'bridge.gap', { from_counter: 5, to_counter: 5, dropped: 1 })])
  server.db.sqlite.prepare("DELETE FROM ingest_keys WHERE source = 'bridge:worker-gap'").run()
  await server.token({ ...hello, incarnation: 'worker-idle' })
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  server.setNow(initialTime + thirtyDays)
  await server.token({ ...hello, incarnation: 'worker-recent' })
  expect(pruneBridge(server.db, { now: initialTime + thirtyDays }).producers).toBe(0)
  expect(pruneBridge(server.db, { now: initialTime + thirtyDays + 1 }).producers).toBe(2)
  expect(
    server.db.sqlite.prepare('SELECT incarnation FROM producers ORDER BY incarnation').all(),
  ).toEqual([
    { incarnation: 'worker-gap' },
    { incarnation: 'worker-hole' },
    { incarnation: 'worker-recent' },
  ])
})

test('approval retention expires old rows and caps signals at 50000, oldest first', async () => {
  const at = new Date(initialTime).toISOString()
  const older = new Date(initialTime - 30 * 24 * 60 * 60 * 1000 - 1).toISOString()
  const insert = server.db.sqlite.prepare(
    "INSERT INTO approval_signals (producer_id, profile, hook, payload, at) VALUES ('fixture', 'builder', 'pre_approval_request', '{}', ?)",
  )
  server.db.tx(() => {
    insert.run(older)
    for (let i = 0; i < 50002; i++) insert.run(at)
  })
  expect(pruneBridge(server.db, { now: initialTime })).toEqual({ producers: 0, approvalSignals: 3 })
  expect(
    server.db.sqlite
      .prepare('SELECT count(*) AS n, min(id) AS first, max(id) AS last FROM approval_signals')
      .get(),
  ).toEqual({ n: 50000, first: 4, last: 50003 })
  expect(pruneBridge(server.db, { now: initialTime }).approvalSignals).toBe(0)
})

test('producer authentication and approval expiry have indexed query plans', () => {
  expect(
    JSON.stringify(
      server.db.sqlite
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM producers WHERE token_hash = ?')
        .all('a'.repeat(64)),
    ),
  ).toContain('producers_token_hash')
  expect(
    JSON.stringify(
      server.db.sqlite
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM approval_signals WHERE at < ?')
        .all(new Date(initialTime).toISOString()),
    ),
  ).toContain('approval_signals_at')
})

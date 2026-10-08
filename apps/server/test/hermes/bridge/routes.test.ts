import { BridgeEventsResponseSchema, BridgeHelloResponseSchema } from '@score/contract'
import { readFileSync } from 'node:fs'
import { SHIPPED_PLUGIN_VERSION } from '../../../src/hermes/bridge/routes.ts'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hashBridgeToken } from '../../../src/hermes/bridge/bootstrap.ts'
import { retireIngestKeys } from '../../../src/hub/retire.ts'
import { event, hello, initialTime, setup } from './helpers.ts'

let server: ReturnType<typeof setup>
beforeEach(() => {
  server = setup()
})
afterEach(async () => {
  await server.close()
})

test('hello requires bootstrap auth and returns contract-valid, hashed, expiring producer credentials', async () => {
  expect(
    (await server.app.inject({ method: 'POST', url: '/bridge/v1/hello', payload: hello }))
      .statusCode,
  ).toBe(401)
  expect((await server.handshake(hello, 'wrong')).statusCode).toBe(401)
  const response = await server.handshake()
  expect(response.statusCode).toBe(200)
  const body = BridgeHelloResponseSchema.parse(response.json())
  expect(body.expiresAt).toBe(new Date(initialTime + 3600_000).toISOString())
  expect(body.enabled).toEqual({ watch: true, gatewayApprovals: true, kanbanGrants: false })
  const rows = server.db.sqlite.prepare('SELECT * FROM producers').all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    profile: hello.profile,
    incarnation: hello.incarnation,
    pid: hello.pid,
    kanban_task_id: hello.kanbanTaskId,
    isolation: hello.isolation,
    token_hash: hashBridgeToken(body.producerToken).toString('hex'),
    acked_through: 0,
  })
  expect(JSON.stringify(rows)).not.toContain(body.producerToken)
  expect((await server.handshake(hello, body.producerToken)).statusCode).toBe(401)
  expect((await server.handshake({ ...hello, pid: -1 })).statusCode).toBe(400)
})

test('re-hello rotates the token, preserves acknowledgement, and refuses identity changes', async () => {
  const first = await server.token()
  await server.send(first, [event(1)])
  const second = await server.token()
  expect(second).not.toBe(first)
  expect(server.db.sqlite.prepare('SELECT acked_through FROM producers').get()).toEqual({
    acked_through: 1,
  })
  expect((await server.send(first, [event(2)])).statusCode).toBe(401)
  expect((await server.send(second, [event(2)])).json()).toEqual({ ackedThrough: 2 })
  for (const change of [{ profile: 'reviewer' }, { pid: 124 }, { kanbanTaskId: 'other' }]) {
    expect((await server.handshake({ ...hello, ...change })).statusCode).toBe(409)
  }
})

const flagCases = (['in_process', 'host', 'unknown'] as const).flatMap((isolation) =>
  Array.from({ length: 4 }, (_, mask) =>
    [false, true].map((disabled) => ({ isolation, mask, disabled })),
  ).flat(),
)
test.each(flagCases)(
  'enabled flags: $isolation private API mask $mask disabled=$disabled',
  async ({ isolation, mask, disabled }) => {
    const names = ['list_gateway_approvals', 'resolve_gateway_approval']
    const privateApis = {
      ...hello.privateApis,
      ...Object.fromEntries(
        names.map((name, bit) => [`tools.approval.${name}`, Boolean(mask & (1 << bit))]),
      ),
    }
    server.disable(disabled ? ['gateway-approvals'] : [])
    const response = await server.handshake({ ...hello, isolation, privateApis })
    expect(BridgeHelloResponseSchema.parse(response.json()).enabled).toEqual({
      watch: true,
      kanbanGrants: false,
      gatewayApprovals: isolation === 'in_process' && (mask & 3) === 3 && !disabled,
    })
  },
)

test('unknown and expired producer tokens have the same 401, bootstrap and browser credentials cannot send', async () => {
  const token = await server.token()
  const unknown = await server.send('a'.repeat(43), [])
  server.setNow(initialTime + 3600_000)
  const expired = await server.send(token, [])
  expect(expired.statusCode).toBe(401)
  expect(expired.body).toBe(unknown.body)
  expect((await server.send(server.bootstrap, [])).statusCode).toBe(401)
  const pairing = server.app.pairing.createToken()
  const paired = await server.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: pairing },
  })
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!
  for (const url of ['/bridge/v1/hello', '/bridge/v1/events']) {
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url,
          headers: { cookie, 'x-score-client': 'web' },
          payload: {},
        })
      ).statusCode,
    ).toBe(401)
  }
})

test('valid batch uses D2.3 observation keys and dedupes projections, events, metrics and acknowledgements', async () => {
  const token = await server.token()
  const submit = vi.spyOn(server.ingest, 'submit')
  const events = [
    event(1, 'pre_tool_call', { tool_name: 'terminal', args: { command: 'pwd' } }),
    event(2, 'post_tool_call', {
      tool_name: 'terminal',
      status: 'ok',
      result: '{"output":"ok"}',
      duration_ms: 9,
    }),
    event(3, 'future_hook'),
  ]
  expect(BridgeEventsResponseSchema.parse((await server.send(token, events)).json())).toEqual({
    ackedThrough: 3,
  })
  expect(
    submit.mock.calls.map(([obs]) => ({
      source: obs.source,
      identity: obs.identity,
      checkpoint: obs.checkpoint,
    })),
  ).toEqual(
    [1, 2, 3].map((counter) => ({
      source: `bridge:${hello.incarnation}`,
      identity: `bridge:${hello.incarnation}:${counter}`,
      checkpoint: { scope: 'events', position: counter, incarnation: hello.incarnation },
    })),
  )
  const tools = server.db.sqlite.prepare('SELECT * FROM session_tool_calls').all()
  const logs = server.db.sqlite.prepare('SELECT * FROM events').all()
  expect(tools).toHaveLength(1)
  expect(logs).toHaveLength(2)
  expect(server.metrics.unknownHooks).toBe(1)
  expect((await server.send(token, events)).json()).toEqual({ ackedThrough: 3 })
  expect(server.db.sqlite.prepare('SELECT * FROM session_tool_calls').all()).toEqual(tools)
  expect(server.db.sqlite.prepare('SELECT * FROM events').all()).toEqual(logs)
  expect(server.metrics.unknownHooks).toBe(1)
})

test('holes stop ack and retirement; late counters advance through previously ingested events', async () => {
  const token = await server.token()
  expect((await server.send(token, [event(1), event(2), event(4)])).json()).toEqual({
    ackedThrough: 2,
  })
  expect((await server.send(token, [event(4)])).json()).toEqual({ ackedThrough: 2 })
  retireIngestKeys(server.db, { keepPositions: 0 })
  expect((await server.send(token, [event(3)])).json()).toEqual({ ackedThrough: 4 })
  expect(server.db.sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 4 })
  expect((await server.send(token, [event(1), event(2)])).json()).toEqual({ ackedThrough: 4 })
})

test.each([
  { events: [event(2), event(1)] },
  { events: [event(1), event(1)] },
  { events: [event(0)] },
  { events: [event(1, 'post_tool_call', { duration_ms: -1 })] },
  { events: [event(1, 'bridge.gap', { from_counter: 1, to_counter: 3, dropped: 3 })] },
])('invalid batch is rejected before any observations are committed', async ({ events }) => {
  const token = await server.token()
  expect((await server.send(token, events)).statusCode).toBe(400)
  expect(server.db.sqlite.prepare('SELECT * FROM ingest_keys').all()).toEqual([])
})

test('limits reject more than 200 events and over 2 MB; exactly 200 succeeds', async () => {
  const token = await server.token()
  expect(
    (
      await server.send(
        token,
        Array.from({ length: 201 }, (_, i) => event(i + 1)),
      )
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await server.send(token, [
        event(1, 'on_interim_message', { text: 'x'.repeat(2 * 1024 * 1024) }),
      ])
    ).statusCode,
  ).toBe(413)
  expect(
    (
      await server.send(
        token,
        Array.from({ length: 200 }, (_, i) => event(i + 1)),
      )
    ).json(),
  ).toEqual({ ackedThrough: 200 })
})

test('producer identity scopes same-counter observations and tools across profiles', async () => {
  const builder = await server.token()
  const reviewer = await server.token({
    ...hello,
    profile: 'reviewer',
    incarnation: 'worker-reviewer',
  })
  const batch = [event(1, 'pre_tool_call', { tool_name: 'terminal' })]
  await server.send(builder, batch)
  await server.send(reviewer, batch)
  expect(
    server.db.sqlite.prepare('SELECT profile FROM session_tool_calls ORDER BY profile').all(),
  ).toEqual([{ profile: 'builder' }, { profile: 'reviewer' }])
  expect(server.db.sqlite.prepare('SELECT * FROM ingest_keys').all()).toHaveLength(2)
})

test('bridge bearers cannot mutate API routes, even with CSRF headers or a paired cookie', async () => {
  const token = await server.token()
  const rotated = await server.token()
  const paired = await server.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: server.app.pairing.createToken() },
  })
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!
  for (const bearer of [token, rotated, server.bootstrap, 'a'.repeat(43)]) {
    expect(
      (
        await server.app.inject({
          method: 'DELETE',
          url: '/api/session',
          headers: { ...server.headers(bearer), 'x-score-client': 'web', cookie },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/session/pair',
          headers: server.headers(bearer),
          payload: { token: bearer },
        })
      ).statusCode,
    ).toBe(403)
  }
  expect((await server.app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: true,
  })
})

test('logs never contain bootstrap or producer credentials, including failed requests', async () => {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString())
      done()
    },
  })
  const logged = setup({ logger: { level: 'info', stream } })
  try {
    const token = await logged.token()
    await logged.send(token, [event(1)])
    await logged.handshake(hello, token)
    await logged.send(logged.bootstrap, [])
    await logged.app.inject({
      method: 'POST',
      url: '/bridge/v1/events',
      headers: { ...logged.headers(token), 'content-type': 'application/json' },
      payload: '{invalid',
    })
    expect(chunks.join('')).not.toContain(token)
    expect(chunks.join('')).not.toContain(logged.bootstrap)
    expect(chunks.join('')).toContain('[Redacted]')
  } finally {
    await logged.close()
    stream.end()
  }
})

test.each([
  { pluginVersion: 'unknown' },
  { hermes: { ...hello.hermes, version: 'untested' } },
  { hermes: { ...hello.hermes, codeSha: 'untested' } },
  { privateApis: { ...hello.privateApis, 'tools.approval._lock': false } },
  { privateApis: { ...hello.privateApis, 'tools.approval._gateway_queues': false } },
])('gate #2 untested producer is observe-only: %j', async (patch) => {
  const response = await server.handshake({ ...hello, ...patch })
  expect(response.statusCode).toBe(200)
  expect(response.json().enabled).toMatchObject({ watch: true, gatewayApprovals: false })
})

test('gate #2 server plugin version mirrors the shipped Python client', () => {
  const python = readFileSync(
    new URL('../../../../../hermes-plugin/score_bridge/client.py', import.meta.url),
    'utf8',
  )
  expect(python.match(/^PLUGIN_VERSION = "([^"]+)"/m)?.[1]).toBe(SHIPPED_PLUGIN_VERSION)
})

test.each([Array.from({ length: 17 }, (_, i) => `gate-${i}`), ['invalid gate']])(
  'gate #3 rejects malformed completion gate IDs atomically: %j',
  async (gateIds) => {
    const token = await server.token()
    expect(
      (await server.send(token, [event(1), event(2, 'post_tool_call', { gateIds })])).statusCode,
    ).toBe(400)
    expect(server.db.sqlite.prepare('SELECT * FROM ingest_keys').all()).toEqual([])
  },
)

test.each([
  ['0.21.0+1234', 'fixture', true],
  ['0.21.0', 'fixture', true],
  ['0.21.1+1', 'fixture', false],
  ['0.21.0+1234', 'other-sha', false],
])(
  'producer build %s / %s qualifies for gateway approvals: %s',
  async (version, codeSha, enabled) => {
    const response = await server.handshake({ ...hello, hermes: { version, codeSha } })
    expect(response.json().enabled.gatewayApprovals).toBe(enabled)
  },
)

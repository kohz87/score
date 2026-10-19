import { AgentSummarySchema, ShapeSchema } from '@score/contract'
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { AgentDetailSchema } from '@score/contract'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { FakePort, stepToObservation } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
const patch = (
  body: object,
  headers: Record<string, string> = { 'x-score-client': 'web', cookie },
  agent = 'builder',
) => app.inject({ method: 'PATCH', url: `/api/agents/${agent}/style`, headers, payload: body })
function styleEvents() {
  return env.db.sqlite
    .prepare(
      "SELECT data FROM events WHERE type = 'agent.updated' AND json_extract(data, '$.id') = 'builder'",
    )
    .all()
}
test('fake list and detail expose all four neutral agents from a fenced projection', async () => {
  const response = await app.inject('/api/agents')
  expect(response.statusCode).toBe(200)
  const list = response.json()
  expect(list.items.map((item: { id: string }) => item.id)).toEqual([
    'lead',
    'builder',
    'reviewer',
    'designer',
  ])
  expect(list.asOfSeq).toBe(4)
  for (const agent of list.items) {
    expect(AgentSummarySchema.safeParse(agent).success).toBe(true)
    const detail = await app.inject(`/api/agents/${agent.id}`)
    expect(detail.statusCode).toBe(200)
    expect(AgentDetailSchema.safeParse(detail.json()).success).toBe(true)
    expect(AgentSummarySchema.parse(detail.json())).toEqual(agent)
  }
  expect((await app.inject('/api/agents')).json().asOfSeq).toBe(list.asOfSeq)
  expect((await app.inject('/api/agents/missing')).statusCode).toBe(404)
})
test('style patch persists, emits once, replays receipts and survives app/adapter restart', async () => {
  await app.inject('/api/agents')
  const headers = { 'x-score-client': 'web', cookie, 'idempotency-key': 'style-test' }
  const response = await patch({ color: '#123456', shape: 'hexagon' }, headers)
  expect(response.statusCode).toBe(200)
  expect(response.json().style).toEqual({
    color: '#123456',
    shape: 'hexagon',
    look: 'bot',
    avatar: null,
    avatarEyes: null,
  })
  expect((await patch({ shape: 'hexagon', color: '#123456' }, headers)).json()).toEqual(
    response.json(),
  )
  expect(styleEvents()).toHaveLength(2)
  expect((await patch({ shape: 'star' }, headers)).statusCode).toBe(409)
  expect(
    env.db.sqlite.prepare('SELECT * FROM agent_styles WHERE agent_id = ?').get('builder'),
  ).toMatchObject({ color: '#123456', shape: 'hexagon', updated_at: expect.any(String) })
  await app.close()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: new FakePort(),
    db: env.db,
    ingest: env.ingest,
  })
  expect((await app.inject('/api/agents/builder')).json().style).toEqual(response.json().style)
})
test('concurrent partial patches merge through ingest without losing a field', async () => {
  const results = await Promise.all([patch({ color: '#abcdef' }), patch({ shape: 'cross' })])
  expect(results.map((result) => result.statusCode)).toEqual([200, 200])
  expect((await app.inject('/api/agents/builder')).json().style).toEqual({
    color: '#abcdef',
    shape: 'cross',
    look: 'bot',
    avatar: null,
    avatarEyes: null,
  })
})
test('unchanged style produces no additional event, but stores the override', async () => {
  const agent = (await app.inject('/api/agents/builder')).json()
  const before = styleEvents().length
  expect((await patch(agent.style)).statusCode).toBe(200)
  expect(styleEvents()).toHaveLength(before)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toHaveLength(1)
})
test('fake stream agent changes preserve styles and update projections in the same transaction', async () => {
  await patch({ color: '#112233', shape: 'pill' })
  const builder = (await port.listAgents()).find((agent) => agent.id === 'builder')!
  await env.ingest.submit(
    stepToObservation(
      { at: 1, kind: 'agent.updated', data: { ...builder, status: 'working' } },
      'style-update',
    ),
  )
  const row = env.db.sqlite.prepare('SELECT detail FROM agents_proj WHERE id = ?').get('builder')!
  expect(JSON.parse(String(row.detail))).toMatchObject({
    status: 'working',
    style: { color: '#112233', shape: 'pill' },
  })
  expect(JSON.parse(String(styleEvents().at(-1)!.data))).toMatchObject({
    status: 'working',
    style: { color: '#112233', shape: 'pill' },
  })
})
test.each([
  {},
  { color: 'red' },
  { color: '#123' },
  { shape: 'unknown' },
  { color: null },
  { extra: true },
  { look: 'robot' },
  { look: null },
  { shape: 'dodecagon' },
])('invalid style %j is rejected', async (body) => {
  expect((await patch(body)).statusCode).toBe(400)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
})
test('guard and CSRF are enforced before writes; unknown agent returns 404', async () => {
  expect((await patch({ shape: 'star' }, { 'x-score-client': 'web' })).statusCode).toBe(401)
  expect((await patch({ shape: 'star' }, { cookie })).statusCode).toBe(403)
  expect(
    (
      await patch(
        { shape: 'star' },
        { cookie, 'x-score-client': 'web', origin: 'https://untrusted.example' },
      )
    ).statusCode,
  ).toBe(403)
  expect((await patch({ shape: 'star' }, undefined, 'missing')).statusCode).toBe(404)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
})
test('failed ingest rolls back style, projection and event together', async () => {
  await app.inject('/api/agents')
  env.db.sqlite.exec(
    "CREATE TRIGGER reject_style BEFORE INSERT ON events WHEN NEW.type = 'agent.updated' AND json_extract(NEW.data, '$.style.shape') = 'cross' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  )
  expect((await patch({ shape: 'cross' })).statusCode).toBe(500)
  expect(env.db.sqlite.prepare('SELECT * FROM agent_styles').all()).toEqual([])
  expect((await app.inject('/api/agents/builder')).json().style.shape).toBe('triangle')
})

test('live fixture profiles expose served and unserved agents with run activity through HTTP', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
  const upstream = join(env.home, 'upstream')
  cpSync(join(fixture, 'default'), upstream, { recursive: true })
  for (const name of ['lead', 'builder', 'reviewer', 'designer'])
    cpSync(join(fixture, name), join(upstream, 'profiles', name), { recursive: true })
  writeFileSync(
    join(upstream, 'gateway_state.json'),
    JSON.stringify({ served_profiles: ['lead', 'builder'] }),
  )
  const now = new Date().toISOString()
  env.db.sqlite
    .prepare(
      "INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('profile-run', 'builder', 'score', 'waiting_for_approval', ?, ?)",
    )
    .run(now, now)
  const live = new LivePort({
    scoreHome: env.home,
    hermesHome: upstream,
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    runner: async () => ({ exitCode: 0, stdout: '"fixture-model"' }),
  })
  // Keep this externally observed fixture run out of the Score-started run follower.
  env.db.sqlite.prepare("UPDATE runs SET origin = 'gateway' WHERE id = 'profile-run'").run()
  await live.start(env.ingest)
  await app.close()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'live', SCORE_HERMES_HOME: upstream }),
    logger: false,
    port: live,
    db: env.db,
    ingest: env.ingest,
  })
  try {
    const list = (await app.inject('/api/agents')).json()
    expect(list.items.map((agent: { id: string }) => agent.id)).toEqual([
      'builder',
      'default',
      'designer',
      'lead',
      'reviewer',
    ])
    const builder = AgentDetailSchema.parse((await app.inject('/api/agents/builder')).json())
    expect(builder).toMatchObject({
      name: 'Builder',
      role: 'Builds features',
      served: true,
      status: 'waiting',
      activity: 'Running a turn',
      skills: [{ name: 'implementation', enabled: true }],
    })
    expect(
      AgentDetailSchema.parse((await app.inject('/api/agents/reviewer')).json()),
    ).toMatchObject({ served: false, status: 'offline' })
    expect(AgentDetailSchema.parse((await app.inject('/api/agents/lead')).json())).toMatchObject({
      served: true,
      status: 'idle',
    })
  } finally {
    await live.stop()
  }
})

test('PLAN 10.2: look and the new shapes persist, merge with the rest, emit, and survive a restart', async () => {
  await app.inject('/api/agents')
  const first = await patch({ look: 'chibi' })
  expect(first.statusCode).toBe(200)
  expect(first.json().style).toMatchObject({ look: 'chibi', avatar: null })
  const second = await patch({ shape: 'cloud', color: '#0A0B0C' })
  expect(second.json().style).toEqual({
    color: '#0A0B0C',
    shape: 'cloud',
    look: 'chibi',
    avatar: null,
    avatarEyes: null,
  })
  expect(
    env.db.sqlite.prepare('SELECT color, shape, look, avatar_rev FROM agent_styles').all(),
  ).toEqual([{ color: '#0A0B0C', shape: 'cloud', look: 'chibi', avatar_rev: null }])
  const events = styleEvents().map((row) => JSON.parse(String(row.data)).style)
  expect(events.at(-1)).toMatchObject({ shape: 'cloud', look: 'chibi' })
  const count = events.length
  // The same look again changes nothing and says nothing.
  expect((await patch({ look: 'chibi' })).statusCode).toBe(200)
  expect(styleEvents()).toHaveLength(count)
  expect((await patch({ look: 'bot' })).json().style.look).toBe('bot')
  expect(styleEvents()).toHaveLength(count + 1)
  await app.close()
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port: new FakePort(),
    db: env.db,
    ingest: env.ingest,
  })
  expect((await app.inject('/api/agents/builder')).json().style).toMatchObject({
    shape: 'cloud',
    look: 'bot',
  })
})
test('PLAN 10.2: every one of the 20 shapes is accepted by the style route', async () => {
  for (const shape of ShapeSchema.options) {
    const response = await patch({ shape })
    expect(response.statusCode, shape).toBe(200)
    expect(response.json().style.shape).toBe(shape)
  }
})
test('PLAN 10.2: a client cannot set the picture through the style route', async () => {
  await app.inject('/api/agents')
  const response = await patch({ shape: 'moon', avatar: 'forged' })
  expect(response.statusCode).toBe(200)
  expect(response.json().style.avatar ?? null).toBeNull()
  expect(env.db.sqlite.prepare('SELECT avatar_rev FROM agent_styles').all()).toEqual([
    { avatar_rev: null },
  ])
  // Nothing but a picture to set is nothing to do.
  expect((await patch({ avatar: 'forged' })).statusCode).toBe(400)
})

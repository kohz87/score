import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  ConfigApplyResponseSchema,
  ConfigPreviewResponseSchema,
  ConfigSearchResponseSchema,
  ConnectResultSchema,
  ConnectionsResponseSchema,
  HermesCheckSchema,
  ProvidersResponseSchema,
  ProviderItemSchema,
  PluginItemSchema,
  PluginsResponseSchema,
} from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let headers: { 'x-score-client': string; cookie: string }
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  await port.start(env.ingest)
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
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})
const post = (url: string, payload?: object) =>
  app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) })

test('providers list validates and carries usedBy from the agents models', async () => {
  const response = await app.inject('/api/settings/providers')
  expect(response.statusCode).toBe(200)
  const { items } = ProvidersResponseSchema.parse(response.json())
  expect(items.map((item) => item.id)).toEqual(['demo', 'openrouter', 'anthropic', 'openai-codex'])
  expect(items.find((item) => item.id === 'demo')!.usedBy.length).toBeGreaterThan(0)
  expect(items.find((item) => item.id === 'openrouter')!.usedBy).toEqual([])
})
test('mutations need a human session; connect returns the terminal command', async () => {
  expect(
    (await app.inject({ method: 'POST', url: '/api/settings/providers/openrouter/connect' }))
      .statusCode,
  ).toBeGreaterThanOrEqual(401)
  const response = await post('/api/settings/providers/openrouter/connect')
  expect(ConnectResultSchema.parse(response.json())).toEqual({
    next: 'run_in_terminal',
    command: 'hermes auth add openrouter',
  })
  expect((await post('/api/settings/providers/nope/connect')).statusCode).toBe(404)
})
test('adding a local provider returns the item, then it lists; duplicates conflict', async () => {
  const body = { label: 'Lab GPU', baseUrl: 'http://10.0.0.5:8080/v1', model: 'llama-3' }
  const created = await post('/api/settings/providers/local', body)
  expect(created.statusCode).toBe(200)
  expect(ProviderItemSchema.parse(created.json())).toMatchObject({ id: 'lab-gpu', usedBy: [] })
  const { items } = ProvidersResponseSchema.parse(
    (await app.inject('/api/settings/providers')).json(),
  )
  expect(items.map((item) => item.id)).toContain('lab-gpu')
  expect((await post('/api/settings/providers/local', body)).statusCode).toBe(409)
  for (const bad of [
    { ...body, baseUrl: 'ftp://x' },
    { ...body, model: '--flag' },
    { ...body, extra: 1 },
  ])
    expect((await post('/api/settings/providers/local', bad)).statusCode).toBe(400)
})
test('connections list, tool server and messaging connect', async () => {
  const connections = ConnectionsResponseSchema.parse(
    (await app.inject('/api/settings/connections')).json(),
  )
  expect(connections.toolServers.length).toBeGreaterThan(0)
  expect(connections.messaging.map((row) => row.platform)).toContain('telegram')
  const server = await post('/api/settings/tool-servers', {
    name: 'docs',
    url: 'https://mcp.example.com/sse',
  })
  expect(ConnectResultSchema.parse(server.json()).next).toBe('run_in_terminal')
  expect((await post('/api/settings/tool-servers', { name: 'docs' })).statusCode).toBe(400)
  expect(
    (await post('/api/settings/tool-servers', { name: 'd', command: ['-x'] })).statusCode,
  ).toBe(400)
  const messaging = await post('/api/settings/messaging/telegram/connect')
  expect(ConnectResultSchema.parse(messaging.json()).command).toBe('hermes gateway setup')
  expect((await post('/api/settings/messaging/BAD/connect')).statusCode).toBe(400)
})

const PLANTED = 'fake-secret-do-not-show'
test('config search finds by name and comment and never returns credential-shaped keys', async () => {
  const byName = ConfigSearchResponseSchema.parse(
    (await app.inject('/api/settings/config?q=max_turns')).json(),
  )
  expect(byName.items.map((item) => item.key)).toEqual(['agent.max_turns'])
  expect(byName.items[0]).toMatchObject({ value: 60, file: 'config.yaml' })
  const byComment = ConfigSearchResponseSchema.parse(
    (await app.inject('/api/settings/config?q=long-term%20memory')).json(),
  )
  expect(byComment.items.map((item) => item.key)).toEqual(['memory.enabled'])
  for (const q of ['api_key', 'vision', 'key', '']) {
    const response = await app.inject(`/api/settings/config?q=${q}`)
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(PLANTED)
    expect(response.body).not.toContain('api_key')
  }
  expect((await app.inject('/api/settings/config?q=a&extra=1')).statusCode).toBe(400)
  expect((await app.inject(`/api/settings/config?q=${'a'.repeat(201)}`)).statusCode).toBe(400)
})
test('config apply needs a human session and the preview hash; stale hashes are 409', async () => {
  const changes = [{ key: 'display.compact', value: true }]
  const preview = ConfigPreviewResponseSchema.parse(
    (await post('/api/settings/config/preview', { changes })).json(),
  )
  expect(preview.diff).toContain('+display.compact: true')
  const body = { changes, expectedDiffHash: preview.hash }
  expect(
    (await app.inject({ method: 'POST', url: '/api/settings/config/apply', payload: body }))
      .statusCode,
  ).toBeGreaterThanOrEqual(401)
  const wrong = await post('/api/settings/config/apply', {
    ...body,
    expectedDiffHash: 'f'.repeat(64),
  })
  expect(wrong.statusCode).toBe(409)
  expect(wrong.json()).toMatchObject({ error: { code: 'conflict' } })
  expect((await post('/api/settings/config/apply', { changes })).statusCode).toBe(400)
  const applied = await post('/api/settings/config/apply', body)
  expect(ConfigApplyResponseSchema.parse(applied.json())).toEqual({
    ok: true,
    restartRequired: false,
  })
  const after = ConfigSearchResponseSchema.parse(
    (await app.inject('/api/settings/config?q=display.compact')).json(),
  )
  expect(after.items[0]!.value).toBe(true)
  // The applied change moved the baseline: the old hash no longer matches.
  expect((await post('/api/settings/config/apply', body)).statusCode).toBe(409)
  const restart = [{ key: 'gateway.port', value: 9001 }]
  const second = ConfigPreviewResponseSchema.parse(
    (await post('/api/settings/config/preview', { changes: restart })).json(),
  )
  expect(
    (
      await post('/api/settings/config/apply', { changes: restart, expectedDiffHash: second.hash })
    ).json(),
  ).toEqual({ ok: true, restartRequired: true })
})
test('credential-shaped, env-backed and unknown keys are 400 on preview and apply', async () => {
  for (const key of [
    'auxiliary.vision.api_key',
    'OPENROUTER_API_KEY',
    'providers.x.base_url',
    'nope.nothing',
  ]) {
    const changes = [{ key, value: 'x' }]
    expect((await post('/api/settings/config/preview', { changes })).statusCode).toBe(400)
    expect(
      (await post('/api/settings/config/apply', { changes, expectedDiffHash: 'a'.repeat(64) }))
        .statusCode,
    ).toBe(400)
  }
  const search = await app.inject('/api/settings/config?q=vision')
  expect(search.body).not.toContain(PLANTED)
  for (const bad of [
    [],
    [
      { key: 'display.compact', value: true },
      { key: 'display.compact', value: false },
    ],
  ])
    expect((await post('/api/settings/config/preview', { changes: bad })).statusCode).toBe(400)
})

const patch = (url: string, payload: object) =>
  app.inject({ method: 'PATCH', url, headers, payload })

test('plugins list per profile; enable and disable stick, the bridge stays locked', async () => {
  const list = async (agent: string) =>
    PluginsResponseSchema.parse((await app.inject(`/api/settings/plugins?agent=${agent}`)).json())
      .items
  const before = await list('builder')
  expect(before.find((item) => item.id === 'score-bridge')).toMatchObject({
    enabled: true,
    locked: true,
  })
  const off = await patch('/api/settings/plugins/memory-notes?agent=builder', { enabled: false })
  expect(PluginItemSchema.parse(off.json())).toMatchObject({ id: 'memory-notes', enabled: false })
  expect((await list('builder')).find((item) => item.id === 'memory-notes')!.enabled).toBe(false)
  // Another profile keeps its own state.
  expect((await list('lead')).find((item) => item.id === 'memory-notes')!.enabled).toBe(true)
  expect(
    (await patch('/api/settings/plugins/score-bridge?agent=builder', { enabled: false }))
      .statusCode,
  ).toBe(409)
  expect(
    (await patch('/api/settings/plugins/nope?agent=builder', { enabled: true })).statusCode,
  ).toBe(404)
  expect(
    (await patch('/api/settings/plugins/memory-notes?agent=builder', { enabled: 'yes' }))
      .statusCode,
  ).toBe(400)
  expect((await app.inject('/api/settings/plugins')).statusCode).toBe(400)
  expect((await app.inject('/api/settings/plugins?agent=ghost')).statusCode).toBe(404)
})
test('plugin changes need a human session', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: '/api/settings/plugins/memory-notes?agent=builder',
    payload: { enabled: false },
  })
  expect(response.statusCode).toBeGreaterThanOrEqual(401)
})

test('the fake adapter answers the Hermes version check cleanly', async () => {
  const check = HermesCheckSchema.parse((await post('/api/settings/hermes/check')).json())
  expect(check.compatible).toBe(true)
  const accepted = await post('/api/settings/hermes/accept', { hash: check.hash })
  expect(accepted.json()).toEqual({ ok: true })
})

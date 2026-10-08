import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  ConnectResultSchema,
  ConnectionsResponseSchema,
  ProvidersResponseSchema,
  ProviderItemSchema,
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

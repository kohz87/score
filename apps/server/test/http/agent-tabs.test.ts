import { AgentDetailSchema } from '@score/contract'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let cookie: string
let extraHome: string | undefined
async function boot(port: FakePort | LivePort) {
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
}
beforeEach(async () => {
  env = setup()
  await boot(new FakePort(1, { db: env.db }, false))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  if (extraHome) rmSync(extraHome, { recursive: true, force: true })
  extraHome = undefined
})
const human = () => ({ 'x-score-client': 'web', cookie })
const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = human(),
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const updates = (id: string) =>
  env.db.sqlite
    .prepare(
      "SELECT data FROM events WHERE type = 'agent.updated' AND json_extract(data, '$.id') = ?",
    )
    .all(id)

test('model: PUT changes the model, returns the detail and announces agent.updated', async () => {
  const before = updates('builder').length
  const response = await call('PUT', '/api/agents/builder/model', {
    model: 'next-model',
    provider: 'acme',
  })
  expect(response.statusCode).toBe(200)
  const detail = AgentDetailSchema.parse(response.json())
  expect(detail.model).toMatchObject({ id: 'next-model', via: 'acme' })
  expect(updates('builder').length).toBe(before + 1)
  const read = AgentDetailSchema.parse((await call('GET', '/api/agents/builder')).json())
  expect(read.model!.id).toBe('next-model')
})
test('mutations need a paired human and valid bodies', async () => {
  const anonymous = { 'x-score-client': 'web' }
  for (const [method, url, body] of [
    ['PUT', '/api/agents/builder/model', { model: 'm' }],
    ['POST', '/api/agents/builder/skills', { name: 'a/b' }],
    ['PATCH', '/api/agents/builder/skills/collaboration', { enabled: false }],
    ['POST', '/api/agents/builder/memory', { text: 'x' }],
    ['DELETE', '/api/agents/builder/memory/m-000000000000', undefined],
    ['PATCH', '/api/agents/builder/tools/web', { enabled: false }],
  ] as const) {
    const denied = await call(method, url, body, anonymous)
    expect([401, 403]).toContain(denied.statusCode)
  }
  expect((await call('PUT', '/api/agents/builder/model', { model: '--force' })).statusCode).toBe(
    400,
  )
  expect((await call('PUT', '/api/agents/builder/model', {})).statusCode).toBe(400)
  expect((await call('PUT', '/api/agents/nobody/model', { model: 'm' })).statusCode).toBe(404)
  expect((await call('PATCH', '/api/agents/builder/skills/x', { enabled: 'y' })).statusCode).toBe(
    400,
  )
})
test('skills: list, toggle, install, hub search', async () => {
  const list = (await call('GET', '/api/agents/builder/skills')).json()
  expect(list.items).toContainEqual({ name: 'collaboration', enabled: true })
  const toggled = await call('PATCH', '/api/agents/builder/skills/collaboration', {
    enabled: false,
  })
  expect(toggled.json()).toEqual({ name: 'collaboration', enabled: false })
  const detail = AgentDetailSchema.parse((await call('GET', '/api/agents/builder')).json())
  expect(detail.skills).toContainEqual({ name: 'collaboration', enabled: false })
  expect(
    (await call('PATCH', '/api/agents/builder/skills/missing', { enabled: true })).statusCode,
  ).toBe(404)
  const hub = (await call('GET', '/api/skills/hub?q=changelog')).json()
  expect(hub.items.map((item: { name: string }) => item.name)).toEqual(['changelog-writer'])
  expect((await call('GET', '/api/skills/hub')).json()).toEqual({ items: [] })
  const installed = await call('POST', '/api/agents/builder/skills', {
    name: hub.items[0].identifier,
  })
  expect(installed.json().items).toContainEqual({ name: 'changelog-writer', enabled: true })
})
test('memory: search, page, add, delete; add is idempotent per key', async () => {
  const page = (await call('GET', '/api/agents/builder/memory')).json()
  expect(page.items).toHaveLength(3)
  expect(page.nextCursor).toBeNull()
  expect((await call('GET', '/api/agents/builder/memory?q=friday')).json().items).toHaveLength(1)
  const headers = { ...human(), 'idempotency-key': 'mem-1' }
  const added = await call(
    'POST',
    '/api/agents/builder/memory',
    { text: ' Remember the demo. ' },
    headers,
  )
  expect(added.statusCode).toBe(200)
  expect(added.json()).toMatchObject({ text: 'Remember the demo.' })
  const again = await call(
    'POST',
    '/api/agents/builder/memory',
    { text: ' Remember the demo. ' },
    headers,
  )
  expect(again.json()).toEqual(added.json())
  const detail = AgentDetailSchema.parse((await call('GET', '/api/agents/builder')).json())
  expect(detail.memory[0]!.text).toBe('Remember the demo.')
  const removed = await call('DELETE', `/api/agents/builder/memory/${added.json().id}`)
  expect(removed.json()).toEqual({ id: added.json().id })
  expect((await call('DELETE', `/api/agents/builder/memory/${added.json().id}`)).statusCode).toBe(
    404,
  )
  expect((await call('DELETE', '/api/agents/builder/memory/bad')).statusCode).toBe(400)
  expect((await call('POST', '/api/agents/builder/memory', { text: '  ' })).statusCode).toBe(400)
  expect((await call('GET', '/api/agents/builder/memory?cursor=abc')).statusCode).toBe(400)
})
test('tools: toggle builtin; MCP rows are read-only (501)', async () => {
  const off = await call('PATCH', '/api/agents/builder/tools/web', { enabled: false })
  expect(off.json()).toMatchObject({ id: 'web', kind: 'builtin', enabled: false })
  const detail = AgentDetailSchema.parse((await call('GET', '/api/agents/builder')).json())
  expect(detail.tools.find((tool) => tool.id === 'web')!.enabled).toBe(false)
  const mcp = await call('PATCH', '/api/agents/builder/tools/tracker', { enabled: false })
  expect(mcp.statusCode).toBe(501)
  expect(mcp.json().error.code).toBe('not_implemented')
  expect(
    (await call('PATCH', '/api/agents/builder/tools/nope', { enabled: true })).statusCode,
  ).toBe(404)
})

test('live adapter: memory writes are 501 with a clear message; reads work from the profile files', async () => {
  extraHome = mkdtempSync(join(tmpdir(), 'score-tabs-http-'))
  const fixture = fileURLToPath(new URL('../fixtures/hermes/profiles/', import.meta.url))
  cpSync(join(fixture, 'default'), extraHome, { recursive: true })
  cpSync(join(fixture, 'builder'), join(extraHome, 'profiles', 'builder'), { recursive: true })
  const runner = vi.fn(async (args: string[]) => ({
    exitCode: 0,
    stdout: args.includes('model') ? '"fixture-model"' : '[]',
  }))
  const live = new LivePort({
    scoreHome: env.home,
    hermesHome: extraHome,
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    runner,
  })
  await live.start(env.ingest)
  await app.close()
  await boot(live)
  try {
    const page = (await call('GET', '/api/agents/builder/memory')).json()
    expect(page.items).toHaveLength(4)
    const add = await call('POST', '/api/agents/builder/memory', { text: 'hello' })
    expect(add.statusCode).toBe(501)
    expect(add.json().error.message).toMatch(/read-only/)
    const del = await call('DELETE', `/api/agents/builder/memory/${page.items[0].id}`)
    expect(del.statusCode).toBe(501)
    const model = await call('PUT', '/api/agents/builder/model', { model: 'next' })
    expect(model.statusCode).toBe(200)
    expect(runner).toHaveBeenCalledWith(
      ['-p', 'builder', 'config', 'set', 'model.default', 'next'],
      expect.objectContaining({ hermesHome: extraHome }),
    )
    expect((await call('PUT', '/api/agents/nobody/model', { model: 'next' })).statusCode).toBe(404)
  } finally {
    await live.stop()
  }
})

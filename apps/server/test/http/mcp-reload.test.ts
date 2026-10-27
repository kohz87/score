import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { HttpError } from '../../src/errors.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

// 3.7.9 (decision 140): Reload MCP restarts an agent's gateway, only while Score sees nothing in flight there.

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let cookie: string
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  app = buildApp({
    config: loadConfig({ SCORE_HOME: env.home }),
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
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const reload = (agentId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/mcp/reload`,
    headers: { cookie, 'x-score-client': 'web' },
  })
const run = (id: string, profile: string, status = 'running') => {
  const now = new Date().toISOString()
  env.db.sqlite
    .prepare(
      'INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, profile, 'score', status, now, now)
}

test('an idle agent’s gateway is restarted for that profile only', async () => {
  const res = await reload('builder')
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json()).toEqual({ agentId: 'builder', scope: 'profile' })
  expect(port.gatewayRestarts).toEqual(['builder'])
})

test('a running agent is refused; another agent’s run doesn’t block a named profile', async () => {
  run('r-builder', 'builder')
  const busy = await reload('builder')
  expect(busy.statusCode).toBe(409)
  expect(busy.json().error).toMatchObject({ code: 'agent_busy' })
  expect(busy.json().error.message).toContain('working right now')
  expect((await reload('reviewer')).statusCode).toBe(200)
  expect(port.gatewayRestarts).toEqual(['reviewer'])
})

test('default restarts the shared gateway, so any agent’s run or pending approval blocks it', async () => {
  run('r-builder', 'builder')
  expect((await reload('default')).statusCode).toBe(409)
  env.db.sqlite.prepare("UPDATE runs SET status = 'completed'").run()
  const ok = await reload('default')
  expect(ok.statusCode, ok.body).toBe(200)
  expect(ok.json()).toEqual({ agentId: 'default', scope: 'gateway' })
})

test('a refusal from Hermes is a 502 that names what to check; a second click while one runs is refused', async () => {
  vi.spyOn(port, 'restartGateway').mockRejectedValueOnce(
    new HttpError(502, 'gateway_restart_failed', 'Hermes didn’t restart builder’s gateway.'),
  )
  const failed = await reload('builder')
  expect(failed.statusCode).toBe(502)
  expect(failed.json().error.code).toBe('gateway_restart_failed')
  let finish = () => undefined as void
  vi.spyOn(port, 'restartGateway').mockImplementationOnce(
    () => new Promise<void>((resolve) => (finish = resolve)),
  )
  const first = reload('builder')
  await vi.waitFor(() => expect(port.restartGateway).toHaveBeenCalledTimes(2))
  expect((await reload('builder')).statusCode).toBe(409)
  finish()
  expect((await first).statusCode).toBe(200)
})

test('without pairing the reload is refused', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agents/builder/mcp/reload',
    headers: { 'x-score-client': 'web' },
  })
  expect(res.statusCode).toBe(401)
})

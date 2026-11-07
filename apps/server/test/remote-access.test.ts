import { expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { createHermesPort } from '../src/hermes/index.ts'
import { cleanup, env, headers, makeApp, origin, pair } from './remote-helpers.ts'

test('authentication runs before status reads or adapter previews', async () => {
  const config = loadConfig(env)
  const port = createHermesPort(config)
  const status = vi.fn(() => {
    throw new Error('Must not read status')
  })
  const agents = vi.spyOn(port, 'listAgents')
  const configPreview = vi.spyOn(port, 'previewConfig')
  const filePreview = vi.spyOn(port, 'readAgentFile')
  const app = buildApp({ config, port, getSystemStatus: status, logger: false })
  cleanup.push(() => app.close())
  for (const url of ['/api/system', '/api/agents'])
    expect((await app.inject({ url, headers })).statusCode).toBe(401)
  for (const url of ['/api/settings/config/preview', '/api/agents/lead/files/SOUL.md/preview'])
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { content: 'x', changes: [] } }))
        .statusCode,
    ).toBe(401)
  for (const spy of [status, agents, configPreview, filePreview]) expect(spy).not.toHaveBeenCalled()
})
test.each([
  ['GET', '/api/system'],
  ['GET', '/api/agents'],
  ['GET', '/api/approvals'],
  ['GET', '/api/stream'],
  ['GET', '/api/media/private'],
  ['GET', '/api/reports/export.csv'],
  ['HEAD', '/api/health'],
  ['HEAD', '/api/session'],
  ['HEAD', '/api/agents'],
  ['POST', '/api/settings/config/preview'],
  ['POST', '/api/agents/lead/files/SOUL.md/preview'],
  ['GET', '/%61pi/system'],
  ['GET', '/api/%73ession'],
  ['POST', '/api/session/%70air'],
  ['GET', '/api/session/'],
  ['GET', '/api/future'],
  ['GET', '/private.txt'],
  ['GET', '/bridge/v1/decisions'],
])('unpaired %s %s is denied before any handler', async (method, url) => {
  const app = makeApp()
  const response = await app.inject({
    method: method as 'GET' | 'HEAD' | 'POST',
    url,
    headers,
    payload: method === 'POST' ? { content: 'secret', token: 'x' } : undefined,
  })
  expect(response.statusCode).toBe(401)
  expect(response.headers['cache-control']).toBe('no-store')
})
test('public routes disclose only minimal health and a boolean session', async () => {
  const app = makeApp()
  expect((await app.inject({ url: '/api/health', headers })).json()).toEqual({
    ok: true,
    contract: 1,
  })
  expect((await app.inject({ url: '/api/session', headers })).json()).toEqual({ paired: false })
  const token = app.pairing.createToken()
  const options = { method: 'POST' as const, url: '/api/session/pair', headers, payload: { token } }
  expect((await app.inject(options)).statusCode).toBe(204)
  expect((await app.inject(options)).statusCode).toBe(401)
})

test('producer credentials cannot authorize browser APIs, even with a paired cookie', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  expect(
    (
      await app.inject({
        url: '/api/system',
        headers: { ...headers, cookie, authorization: `Bearer ${'a'.repeat(43)}` },
      })
    ).statusCode,
  ).toBe(401)
})
test.each([
  'attacker.example',
  'score.lan',
  'score.lan:8741.attacker.example',
  'SCORE.LAN:8741',
  '127.0.0.1:8741',
])('foreign or inexact Host %s is rejected on public routes', async (host) => {
  expect((await makeApp().inject({ url: '/api/health', headers: { host } })).statusCode).toBe(403)
})
test.each([
  undefined,
  'null',
  'http://attacker.example',
  'http://score.lan:8741',
  'https://score.lan:8741/',
])('remote mutations refuse Origin %s', async (origin) => {
  const app = makeApp()
  const token = app.pairing.createToken()
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/session/pair',
        headers: { host: headers.host, 'x-score-client': 'web', ...(origin ? { origin } : {}) },
        payload: { token },
      })
    ).statusCode,
  ).toBe(403)
  expect(
    (await app.inject({ method: 'POST', url: '/api/session/pair', headers, payload: { token } }))
      .statusCode,
  ).toBe(204)
})
test('forwarded headers cannot change peer, host or origin authority', async () => {
  const app = makeApp()
  expect(
    (
      await app.inject({
        url: '/api/health',
        headers: { host: 'foreign', 'x-forwarded-host': headers.host },
      })
    ).statusCode,
  ).toBe(403)
  const cookie = await pair(app)
  expect(app.pairing.browsers(cookie)[0]?.address).toBe('127.0.0.1')
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/session',
        headers: { ...headers, cookie, origin: 'null', 'x-forwarded-proto': 'http' },
      })
    ).statusCode,
  ).toBe(403)
})
test('remote cookies are secure only for TLS, and management IDs never grant access', async () => {
  const app = makeApp()
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin },
    payload: { token: app.pairing.createToken() },
  })
  expect(response.headers['set-cookie']).toContain('; HttpOnly; SameSite=Strict;')
  expect(response.headers['set-cookie']).toContain('; Secure')
  expect(response.headers['set-cookie']).not.toContain('Domain=')
  const cookie = String(response.headers['set-cookie']).split(';')[0]!
  const browser = app.pairing.browsers(cookie)[0]!
  expect(browser.current).toBe(true)
  expect(browser).not.toHaveProperty('hash')
  expect(app.pairing.isPaired(`score_session=${browser.id}`)).toBe(false)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
  ).toBe(200)
  app.pairing.revokeBrowser(browser.id)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
  ).toBe(401)
})

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Server as HttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test, vi } from 'vitest'
import { PairedBrowsersSchema } from '@score/contract'
import { buildApp, buildBridgeApp } from '../src/app.ts'
import { SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from '../src/auth/pairing.ts'
import { SqliteSessionStore } from '../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, openDatabase, getEpoch } from '../src/db/index.ts'
import { createIngest } from '../src/hub/ingest.ts'
import { loadWebAssets } from '../src/http/web-assets.ts'
import { startServer } from '../src/start-server.ts'
import { createHermesPort } from '../src/hermes/index.ts'
import { readStream } from './hub/sse-helpers.ts'
import { testCert, testKey } from './fixtures/tls.ts'

const origin = 'http://score.lan:8741'
const headers = { host: 'score.lan:8741', origin, 'x-score-client': 'web' }
const env = {
  SCORE_REMOTE: '1',
  SCORE_REMOTE_INSECURE_HTTP: 'accept',
  SCORE_PUBLIC_ORIGINS: origin,
}

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
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.useRealTimers()
})

function makeApp(clock?: () => number, tls = false) {
  const config = loadConfig(
    tls
      ? {
          ...env,
          SCORE_REMOTE_INSECURE_HTTP: undefined,
          SCORE_TLS_CERT: '/tmp/cert',
          SCORE_TLS_KEY: '/tmp/key',
          SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
        }
      : env,
  )
  const app = buildApp({ config, clock, logger: false })
  cleanup.push(() => app.close())
  return app
}
async function pair(app: FastifyInstance, origin = headers.origin) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin },
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'score-remote-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test.each([
  ['GET', '/api/system'],
  ['GET', '/api/agents'],
  ['GET', '/api/tasks'],
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
  'https://score.lan:8741',
  'http://score.lan:8741/',
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
  const app = makeApp(undefined, true)
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin: 'https://score.lan:8741' },
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
test('pairing attempts have bounded peer backoff and global limits that recover', async () => {
  let now = 1000
  const app = makeApp(() => now)
  for (let i = 0; i < 5; i++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/session/pair',
          headers,
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(401)
  const token = app.pairing.createToken()
  expect(
    (await app.inject({ method: 'POST', url: '/api/session/pair', headers, payload: { token } }))
      .statusCode,
  ).toBe(429)
  now += 60_000
  expect(
    (await app.inject({ method: 'POST', url: '/api/session/pair', headers, payload: { token } }))
      .statusCode,
  ).toBe(204)
  for (let i = 0; i < 59; i++)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/session/pair',
          remoteAddress: `192.168.1.${i + 1}`,
          headers,
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(401)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/session/pair',
        remoteAddress: '192.168.2.1',
        headers,
        payload: { token: 'wrong' },
      })
    ).statusCode,
  ).toBe(429)
  now += 60_000
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/session/pair',
        remoteAddress: '192.168.2.1',
        headers,
        payload: { token: app.pairing.createToken() },
      })
    ).statusCode,
  ).toBe(204)
})

test('a browser cannot renew past absolute expiry, and idle expiry is server enforced', async () => {
  let now = 1000
  const app = makeApp(() => now)
  const cookie = await pair(app)
  now += SESSION_IDLE_MS - 1
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
  ).toBe(200)
  for (let day = 7; day < 30; day += 1) {
    now = 1000 + day * 24 * 60 * 60 * 1000
    expect(
      (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
    ).toBe(200)
  }
  now = 1000 + SESSION_ABSOLUTE_MS
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
  ).toBe(401)
  const next = await pair(app)
  now += SESSION_IDLE_MS
  expect(
    (await app.inject({ url: '/api/session', headers: { ...headers, cookie: next } })).json(),
  ).toEqual({ paired: false })
})

test.each(['logout', 'revoke', 'idle', 'absolute'] as const)(
  '%s closes open streams without allowing heartbeats to renew sessions',
  async (action) => {
    const dir = directory()
    const db = openDatabase(join(dir, 'score.db'))
    migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
    cleanup.push(() => db.close())
    const ingest = createIngest(db)
    cleanup.push(() => ingest.close())
    let now = Date.now()
    const app = buildApp({
      config: loadConfig(env),
      db,
      ingest,
      getEpoch: () => getEpoch(db),
      logger: false,
      clock: () => now,
      streamOptions: { heartbeatMs: 5 },
      sessionStore: new SqliteSessionStore(db),
    })
    cleanup.push(() => app.close())
    const cookie = await pair(app)
    const abort = new AbortController()
    cleanup.push(() => abort.abort())
    const stream = await readStream(app, '/api/stream', abort.signal, { ...headers, cookie })
    expect(stream.response.headers['cache-control']).toBe('no-store')
    if (action === 'logout')
      await app.inject({ method: 'DELETE', url: '/api/session', headers: { ...headers, cookie } })
    else if (action === 'revoke') app.pairing.revokeBrowser(app.pairing.browsers(cookie)[0]!.id)
    else {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      app.pairing.touch(cookie, '127.0.0.1')
      now += action === 'idle' ? SESSION_IDLE_MS : SESSION_ABSOLUTE_MS
      await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS)
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(stream.ended).toBe(true))
    expect(
      (await app.inject({ url: '/api/stream', headers: { ...headers, cookie } })).statusCode,
    ).toBe(401)
  },
)

test('bridge routes are registered only on the isolated listener in remote mode', async () => {
  const dir = directory()
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const ingest = createIngest(db)
  cleanup.push(() => ingest.close())
  const bridge = {
    db,
    ingest,
    bootstrapHash: Buffer.alloc(32),
    getCompatibility: () => ({ fingerprint: 'test', tested: false, disabled: [] }),
  }
  const browser = buildApp({ config: loadConfig(env), bridge, logger: false })
  cleanup.push(() => browser.close())
  const producer = buildBridgeApp(bridge)
  cleanup.push(() => producer.close())
  expect(browser.hasRoute({ method: 'POST', url: '/bridge/v1/hello' })).toBe(false)
  expect(producer.hasRoute({ method: 'POST', url: '/bridge/v1/hello' })).toBe(true)
  expect((await producer.inject('/api/system')).statusCode).toBe(404)
  expect(
    (
      await producer.inject({
        method: 'POST',
        url: '/bridge/v1/hello',
        remoteAddress: '192.168.1.2',
      })
    ).statusCode,
  ).toBe(403)
})

test('only built assets and the app shell are public; data, maps and odd paths stay private', async () => {
  const dir = directory()
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'export {}')
  writeFileSync(join(dir, 'assets', 'private.json'), '{"secret":true}')
  writeFileSync(join(dir, 'assets', 'app.js.map'), '{}')
  const assets = loadWebAssets(dir)
  const app = buildApp({ config: loadConfig(env), webAssets: assets, logger: false })
  cleanup.push(() => app.close())
  for (const url of ['/', '/pair', '/index.html', '/assets/app.js'])
    expect((await app.inject({ url, headers })).statusCode).toBe(200)
  // An unpaired bookmark gets the same public index.html as "/", so it can show the pairing screen.
  const shell = await app.inject({ url: '/tasks', headers })
  expect(shell.statusCode).toBe(200)
  expect(shell.body).toContain('<div id="root"></div>')
  for (const url of [
    '/assets/private.json',
    '/assets/app.js.map',
    '/assets/%61pp.js',
    '/api/media/secret',
  ])
    expect((await app.inject({ url, headers })).statusCode).toBe(401)
  // A traversal attempt normalises to an in-app path: at most the public shell comes back, never a file.
  const traversal = await app.inject({ url: '/assets/../private', headers })
  expect([200, 401]).toContain(traversal.statusCode)
  expect(traversal.body).not.toContain('secret')
  expect((await app.inject({ method: 'HEAD', url: '/assets/app.js', headers })).statusCode).toBe(
    401,
  )
  const cookie = await pair(app)
  expect((await app.inject({ url: '/tasks', headers: { ...headers, cookie } })).statusCode).toBe(
    200,
  )
  expect(
    (await app.inject({ url: '/bridge/v1/hello', headers: { ...headers, cookie } })).statusCode,
  ).toBe(404)
})

test.each(['bridge', 'browser'] as const)(
  'failed %s bind cleans up both apps and the home lock',
  async (failure) => {
    const dir = directory()
    const web = join(dir, 'web')
    mkdirSync(web)
    writeFileSync(join(web, 'index.html'), '<div id="root"></div>')
    const config = loadConfig({ ...env, SCORE_HOME: join(dir, 'home') })
    let bridge: FastifyInstance | undefined
    const close = vi.fn()
    await expect(
      startServer(config, {
        logger: false,
        webDirectory: web,
        listenBridge: async (app) => {
          bridge = app
          app.addHook('onClose', async () => {
            close()
          })
          if (failure === 'bridge') throw new Error('occupied')
          await app.ready()
        },
        listen: async () => {
          throw new Error('occupied')
        },
      }),
    ).rejects.toThrow(
      `Could not bind the ${failure === 'bridge' ? 'loopback bridge' : 'browser'} listener`,
    )
    expect(bridge).toBeDefined()
    expect(close).toHaveBeenCalledOnce()
    const next = await startServer(config, {
      logger: false,
      webDirectory: web,
      listen: async (app) => {
        await app.ready()
      },
      listenBridge: async (app) => {
        await app.ready()
      },
    })
    await next.close()
  },
)

test('remote session metadata persists with independent management identifiers', () => {
  const dir = directory()
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const store = new SqliteSessionStore(db)
  const value = {
    hash: 'a'.repeat(64),
    id: randomUUID(),
    label: 'Browser',
    address: '192.168.1.10',
    createdAt: 1000,
    lastSeenAt: 1000,
    expiresAt: 3000,
  }
  store.createRemote(value)
  expect(new SqliteSessionStore(db).getRemote(value.hash)).toEqual(value)
  store.touchRemote(value.hash, 2000, '192.168.1.20')
  expect(store.listRemote()).toEqual([{ ...value, lastSeenAt: 2000, address: '192.168.1.20' }])
  store.revokeRemote(value.hash)
  expect(store.getRemote(value.hash)).toBeUndefined()
})

test('TLS startup builds an HTTPS browser listener and an HTTP loopback listener', async () => {
  const dir = directory()
  writeFileSync(join(dir, 'cert.pem'), testCert)
  writeFileSync(join(dir, 'key.pem'), testKey)
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<html><div id="root"></div></html>')
  const config = loadConfig({
    ...env,
    SCORE_HOME: join(dir, 'home'),
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
    SCORE_REMOTE_INSECURE_HTTP: undefined,
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
  })
  const server = await startServer(config, {
    logger: false,
    webDirectory: web,
    listen: async (app) => {
      await app.ready()
    },
    listenBridge: async (app) => {
      await app.ready()
    },
  })
  cleanup.push(() => server.close())
  expect(server.app.server).toBeInstanceOf(HttpsServer)
  expect(server.bridgeApp?.server).not.toBeInstanceOf(HttpsServer)
  const page = await server.app.inject({ url: '/pair', headers })
  expect(page.body).toContain('data-score-transport="tls"')
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { ...headers, origin: 'https://score.lan:8741' },
    payload: { token: server.pairingToken },
  })
  expect(result.statusCode).toBe(204)
  expect(result.headers['set-cookie']).toContain('; Secure')
})

test('invalid TLS and missing web builds fail before opening Score state or starting adapters', async () => {
  const dir = directory()
  writeFileSync(join(dir, 'cert.pem'), 'invalid certificate')
  writeFileSync(join(dir, 'key.pem'), 'invalid key')
  const home = join(dir, 'home')
  const config = loadConfig({
    ...env,
    SCORE_HOME: home,
    SCORE_PUBLIC_ORIGINS: 'https://score.lan:8741',
    SCORE_REMOTE_INSECURE_HTTP: undefined,
    SCORE_TLS_CERT: join(dir, 'cert.pem'),
    SCORE_TLS_KEY: join(dir, 'key.pem'),
  })
  await expect(
    startServer(config, { logger: false, webDirectory: join(dir, 'web') }),
  ).rejects.toThrow()
  expect(existsSync(home)).toBe(false)
  await expect(
    startServer(loadConfig({ ...env, SCORE_HOME: home }), {
      logger: false,
      webDirectory: join(dir, 'web'),
    }),
  ).rejects.toThrow(/run pnpm build/)
  expect(existsSync(home)).toBe(false)
})

test('paired browsers can be listed and revoked over HTTP without exposing credentials', async () => {
  const app = makeApp()
  const first = await pair(app)
  const second = await pair(app)
  const list = await app.inject({
    url: '/api/session/browsers',
    headers: { ...headers, cookie: first },
  })
  expect(list.statusCode).toBe(200)
  const body = PairedBrowsersSchema.parse(list.json())
  expect(body.items).toHaveLength(2)
  expect(JSON.stringify(body)).not.toContain(first.split('=')[1]!)
  const other = body.items.find((item) => !item.current)!
  const revoke = await app.inject({
    method: 'DELETE',
    url: `/api/session/browsers/${other.id}`,
    headers: { ...headers, cookie: first },
  })
  expect(revoke.statusCode).toBe(204)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie: second } })).statusCode,
  ).toBe(401)
  expect((await app.inject({ url: '/api/session/browsers', headers })).statusCode).toBe(401)
  expect(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/session/browsers/${other.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(401)
})

test('remote responses stay no-store even when a handler sets its own cache policy (media)', async () => {
  const app = makeApp()
  // Stands in for the media route, which sets `private, max-age=3600` (audit 2026-10-08).
  app.get('/api/cache-probe', async (_request, reply) =>
    reply.header('cache-control', 'private, max-age=3600').send({ ok: true }),
  )
  const cookie = await pair(app)
  const response = await app.inject({ url: '/api/cache-probe', headers: { ...headers, cookie } })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
})

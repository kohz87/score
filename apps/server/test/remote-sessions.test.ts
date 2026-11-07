import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/auth/pairing.ts'
import { SqliteSessionStore } from '../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../src/config.ts'
import { getEpoch, migrate, openDatabase } from '../src/db/index.ts'
import { createIngest } from '../src/hub/ingest.ts'
import { readStream } from './hub/sse-helpers.ts'
import { cleanup, directory, env, headers, makeApp, pair } from './remote-helpers.ts'

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

test('an event-stream request does not consume the cookie refresh a renewal queued', async () => {
  const dir = directory()
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const ingest = createIngest(db)
  cleanup.push(() => ingest.close())
  const app = buildApp({
    config: loadConfig(env),
    db,
    ingest,
    getEpoch: () => getEpoch(db),
    logger: false,
    streamOptions: { heartbeatMs: 5 },
    sessionStore: new SqliteSessionStore(db),
  })
  cleanup.push(() => app.close())
  const cookie = await pair(app)
  await app.inject({ url: '/api/system', headers: { ...headers, cookie } })
  app.pairing.renewBrowser(app.pairing.browsers(cookie)[0]!.id)
  const abort = new AbortController()
  cleanup.push(() => abort.abort())
  const stream = await readStream(app, '/api/stream', abort.signal, { ...headers, cookie })
  expect(stream.response.headers['set-cookie']).toBeUndefined()
  abort.abort()
  const next = await app.inject({ url: '/api/system', headers: { ...headers, cookie } })
  expect(String(next.headers['set-cookie'])).toContain('Max-Age=')
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

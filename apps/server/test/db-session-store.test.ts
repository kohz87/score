import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildApp } from '../src/app.ts'
import { PairingService } from '../src/auth/pairing.ts'
import { InMemorySessionStore, type SessionStore } from '../src/auth/session-store.ts'
import { SqliteSessionStore } from '../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url))
const hash = createHash('sha256').update('session').digest('hex')
const otherHash = createHash('sha256').update('other').digest('hex')
let dir: string
let now: number
const databases: ScoreDb[] = []
const apps: FastifyInstance[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-test-'))
  now = 1000
})

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const db of databases.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
})

function open(): ScoreDb {
  const db = openDatabase(join(dir, 'score.db'))
  databases.push(db)
  migrate(db, migrationDir)
  return db
}

describe.each(['memory', 'sqlite'] as const)('%s SessionStore shared behavior', (kind) => {
  let store: SessionStore
  beforeEach(() => {
    store =
      kind === 'memory' ? new InMemorySessionStore() : new SqliteSessionStore(open(), () => now)
  })

  test('missing sessions are absent', () => {
    expect(store.has(hash, now)).toBe(false)
  })

  test('created sessions are valid until exactly their expiry', () => {
    store.create(hash, 2000)
    expect(store.has(hash, 1999)).toBe(true)
    expect(store.has(hash, 2000)).toBe(false)
    expect(store.has(hash, 1999)).toBe(false)
  })

  test('creating the same hash replaces its expiry', () => {
    store.create(hash, 1500)
    store.create(hash, 3000)
    expect(store.has(hash, 2000)).toBe(true)
    expect(store.has(hash, 3000)).toBe(false)
  })

  test('revocation is idempotent and preserves other sessions', () => {
    store.create(hash, 3000)
    store.create(otherHash, 3000)
    store.revoke(hash)
    store.revoke(hash)
    expect(store.has(hash, now)).toBe(false)
    expect(store.has(otherHash, now)).toBe(true)
  })

  test('already expired sessions never grant access', () => {
    store.create(hash, now - 1)
    expect(store.has(hash, now)).toBe(false)
  })

  test('PairingService stores only hashes and supports paired access and revocation', () => {
    const create = vi.spyOn(store, 'create')
    const pairing = new PairingService(store, () => now)
    const token = pairing.createToken()
    expect(create).not.toHaveBeenCalled()
    const id = pairing.pair(token)
    expect(create).toHaveBeenCalledExactlyOnceWith(
      createHash('sha256').update(id).digest('hex'),
      now + 2592000 * 1000,
    )
    expect(store.has(id, now)).toBe(false)
    expect(store.has(token, now)).toBe(false)
    expect(pairing.isPaired(`score_session=${token}`)).toBe(false)
    expect(pairing.isPaired(`score_session=${id}`)).toBe(true)
    pairing.revoke(`score_session=${id}`)
    expect(pairing.isPaired(`score_session=${id}`)).toBe(false)
  })
})

test('SQLite sessions persist and revocation remains durable across reopen', () => {
  const db = open()
  const store = new SqliteSessionStore(db, () => now)
  store.create(hash, 3000)
  expect(db.sqlite.prepare('SELECT * FROM sessions').all()).toEqual([
    { hash, expires_at: 3000, created_at: new Date(now).toISOString() },
  ])
  db.close()
  databases.pop()
  const reopened = open()
  const persisted = new SqliteSessionStore(reopened, () => now)
  expect(persisted.has(hash, now)).toBe(true)
  persisted.revoke(hash)
  reopened.close()
  databases.pop()
  expect(new SqliteSessionStore(open(), () => now).has(hash, now)).toBe(false)
})

test('SQLite sessions are pruned on startup, including sessions expiring exactly now', () => {
  const db = open()
  const store = new SqliteSessionStore(db, () => now)
  store.create(hash, 2000)
  store.create(otherHash, 2001)
  db.close()
  databases.pop()
  now = 2000
  const reopened = open()
  new SqliteSessionStore(reopened, () => now)
  expect(reopened.sqlite.prepare('SELECT hash FROM sessions').all()).toEqual([{ hash: otherHash }])
})

test.each(['unknown', hash])(
  'SQLite has miss %s prunes all expired rows and preserves valid sessions',
  (lookup) => {
    const db = open()
    const store = new SqliteSessionStore(db, () => now)
    store.create(hash, 2000)
    store.create(otherHash, 3000)
    expect(store.has(lookup, 2000)).toBe(false)
    expect(db.sqlite.prepare('SELECT hash FROM sessions').all()).toEqual([{ hash: otherHash }])
  },
)

test('a SQLite has hit leaves cleanup until a miss', () => {
  const db = open()
  const store = new SqliteSessionStore(db, () => now)
  store.create(hash, 2000)
  store.create(otherHash, 3000)
  expect(store.has(otherHash, 2000)).toBe(true)
  expect(db.sqlite.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 2 })
})

test('paired HTTP sessions survive app and database restart with no raw credentials stored', async () => {
  const db = open()
  const config = loadConfig({ SCORE_HOME: dir })
  const app = buildApp({
    config,
    logger: false,
    clock: () => now,
    sessionStore: new SqliteSessionStore(db, () => now),
  })
  apps.push(app)
  const token = app.pairing.createToken()
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token },
  })
  expect(response.statusCode).toBe(204)
  const header = response.headers['set-cookie']
  if (typeof header !== 'string') throw new Error('Session cookie missing')
  const cookie = header.split(';')[0]
  if (!cookie) throw new Error('Session cookie missing')
  const id = cookie.slice('score_session='.length)
  const rows = db.sqlite.prepare('SELECT hash FROM sessions').all()
  expect(rows).toEqual([{ hash: createHash('sha256').update(id).digest('hex') }])
  expect(JSON.stringify(rows)).not.toContain(id)
  expect(JSON.stringify(rows)).not.toContain(token)
  await app.close()
  apps.pop()
  db.close()
  databases.pop()
  const reopened = buildApp({
    config,
    logger: false,
    clock: () => now,
    sessionStore: new SqliteSessionStore(open(), () => now),
  })
  apps.push(reopened)
  expect((await reopened.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: true,
  })
  expect(
    (
      await reopened.inject({
        method: 'POST',
        url: '/api/session/pair',
        headers: { 'x-score-client': 'web' },
        payload: { token },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await reopened.inject({
        method: 'DELETE',
        url: '/api/session',
        headers: { 'x-score-client': 'web', cookie },
      })
    ).statusCode,
  ).toBe(204)
  expect((await reopened.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: false,
  })
})

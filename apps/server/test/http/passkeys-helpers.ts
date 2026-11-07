import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { SqliteSessionStore } from '../../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { SoftAuthenticator } from '../webauthn-authenticator.ts'

export const origin = 'https://score.example.ts.net:8741'
export const rpId = 'score.example.ts.net'
export const headers = { host: 'score.example.ts.net:8741', origin, 'x-score-client': 'web' }
export const PASSWORD = 'correct horse battery'
const env = {
  SCORE_REMOTE: '1',
  SCORE_TLS_CERT: '/tmp/cert',
  SCORE_TLS_KEY: '/tmp/key',
  SCORE_PUBLIC_ORIGINS: origin,
}

const cleanup: (() => Promise<unknown> | void)[] = []

export function setupPasskeysTest() {
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })
}

export function makeApp(extra: Record<string, string> = {}) {
  let now = Date.UTC(2026, 9, 9)
  const clock = () => now
  const dir = mkdtempSync(join(tmpdir(), 'score-passkeys-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const app = buildApp({
    config: loadConfig({ ...env, ...extra }),
    db,
    logger: false,
    clock,
    sessionStore: new SqliteSessionStore(db, clock),
    security: new SecurityPassword(dir, clock),
  })
  cleanup.push(() => app.close())
  return {
    app,
    advance: (ms: number) => {
      now += ms
    },
  }
}

export async function pair(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}

export function post(
  app: FastifyInstance,
  url: string,
  payload: object,
  cookie?: string,
  extra = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra },
    payload,
  })
}

export async function paired(app: FastifyInstance) {
  const cookie = await pair(app)
  const set = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(set.statusCode).toBe(204)
  // Setting the first password unlocks the section (3.14.2); lock it so each test proves what the password guards.
  await post(app, '/api/session/security/lock', {}, cookie)
  return cookie
}

export async function unlock(app: FastifyInstance, cookie: string) {
  expect(
    (await post(app, '/api/session/security/unlock', { password: PASSWORD }, cookie)).statusCode,
  ).toBe(200)
}

export async function registrationOptions(
  app: FastifyInstance,
  cookie: string,
  password = PASSWORD,
) {
  const response = await post(
    app,
    '/api/session/passkeys/registration-options',
    { password, label: 'Phone' },
    cookie,
  )
  return response
}

export async function register(
  app: FastifyInstance,
  cookie: string,
  device = new SoftAuthenticator(),
) {
  const options = (await registrationOptions(app, cookie)).json()
  const response = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(options, { origin, rpId }) },
    cookie,
  )
  expect(response.statusCode).toBe(201)
  return device
}

export async function signIn(
  app: FastifyInstance,
  device: SoftAuthenticator,
  opts: { origin?: string; rpId?: string; uv?: boolean; counter?: number } = {},
) {
  const options = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  const response = await post(app, '/api/session/passkey/authentication', {
    response: device.get(options, { origin, rpId, ...opts }),
  })
  return response
}

export const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!

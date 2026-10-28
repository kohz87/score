import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SecurityPassword } from '../src/auth/security-password.ts'
import { SqliteSessionStore } from '../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, openDatabase } from '../src/db/index.ts'
import { terminalLaunch } from '../src/terminal/env.ts'
import { testCert, testKey } from './fixtures/tls.ts'
import { hostPassword } from './helpers/host-password.ts'
import { SoftAuthenticator } from './webauthn-authenticator.ts'

// The passkey half of the terminal's second factor, with the software authenticator and a real database.
const origin = 'https://score.example.ts.net:8741'
const rpId = 'score.example.ts.net'
const headers = { host: 'score.example.ts.net:8741', origin, 'x-score-client': 'web' }
const PASSWORD = 'correct horse battery'
const env = {
  SCORE_REMOTE: '1',
  SCORE_TERMINAL: '1',
  SCORE_TLS_CERT: '/tmp/cert',
  SCORE_TLS_KEY: '/tmp/key',
  SCORE_PUBLIC_ORIGINS: origin,
}

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function makeApp(hostSet: boolean) {
  let now = Date.UTC(2026, 9, 9)
  const clock = () => now
  const dir = mkdtempSync(join(tmpdir(), 'score-terminal-passkey-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  cleanup.push(() => db.close())
  const security = new SecurityPassword(dir, clock)
  const app = buildApp({
    config: loadConfig(env),
    db,
    logger: false,
    clock,
    sessionStore: new SqliteSessionStore(db, clock),
    security,
    https: { cert: testCert, key: testKey },
    terminal: {
      clock,
      isSecure: () => true,
      launch: terminalLaunch({ ...process.env, HOME: dir }),
    },
  })
  cleanup.push(() => app.close())
  return {
    app,
    dir,
    security,
    hostSet,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function post(app: FastifyInstance, url: string, payload: object, cookie?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    payload,
  })
}

async function pairWithPasskey(setup: ReturnType<typeof makeApp>) {
  const { app, dir, security, hostSet } = setup
  const paired = await post(app, '/api/session/pair', { token: app.pairing.createToken() })
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!
  if (hostSet) hostPassword(dir, PASSWORD)
  else await security.set(PASSWORD, undefined)
  const device = new SoftAuthenticator()
  const options = (
    await post(
      app,
      '/api/session/passkeys/registration-options',
      { password: PASSWORD, label: 'Phone' },
      cookie,
    )
  ).json()
  const created = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(options, { origin, rpId }) },
    cookie,
  )
  expect(created.statusCode).toBe(201)
  // Registering needed the password, which made the session fresh: use that proof up first.
  app.pairing.takeFresh(app.pairing.pairedSession(cookie)!, 60_000)
  return { cookie, device }
}

async function assert(
  app: FastifyInstance,
  device: SoftAuthenticator,
  cookie: string,
  opts: { origin?: string; rpId?: string; uv?: boolean } = {},
) {
  const options = (
    await post(app, '/api/session/passkey/authentication-options', {}, cookie)
  ).json()
  return post(
    app,
    '/api/session/passkey/authentication',
    { response: device.get(options, { origin, rpId, ...opts }) },
    cookie,
  )
}

const mint = (app: FastifyInstance, cookie: string) =>
  post(app, '/api/terminal/tickets', {}, cookie)
// Read directly: the HTTP list needs an unlock (3.14.2), and an unlock is itself a fresh password check.
const browsers = async (app: FastifyInstance, cookie: string) => app.pairing.browsers(cookie)

test('a valid passkey assertion by a paired browser makes it fresh, keeps its cookie and mints one ticket', async () => {
  const setup = makeApp(true)
  const { app, advance } = setup
  const { cookie, device } = await pairWithPasskey(setup)
  expect((await mint(app, cookie)).json().error.code).toBe('fresh_auth_required')
  const before = (await browsers(app, cookie)).length
  const signed = await assert(app, device, cookie)
  expect(signed.statusCode).toBe(204)
  // The cookie is untouched and no second pairing appeared.
  expect(signed.headers['set-cookie']).toBeUndefined()
  expect(await browsers(app, cookie)).toHaveLength(before)
  const minted = await mint(app, cookie)
  expect(minted.statusCode).toBe(200)
  // One assertion, one ticket.
  expect((await mint(app, cookie)).statusCode).toBe(403)
  // Fresh proof older than 60 s is no proof.
  expect((await assert(app, device, cookie)).statusCode).toBe(204)
  advance(61_000)
  expect((await mint(app, cookie)).json().error.code).toBe('fresh_auth_required')
})

test('invalid assertions make nothing fresh', async () => {
  const setup = makeApp(true)
  const { app } = setup
  const { cookie, device } = await pairWithPasskey(setup)
  for (const bad of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { uv: false }]) {
    const response = await assert(app, device, cookie, bad)
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect((await mint(app, cookie)).json().error.code).toBe('fresh_auth_required')
  }
  // An unknown authenticator.
  expect((await assert(app, new SoftAuthenticator(), cookie)).statusCode).toBeGreaterThanOrEqual(
    400,
  )
  expect((await mint(app, cookie)).statusCode).toBe(403)
})

test('a passkey counts only while the security password was set on the host', async () => {
  const setup = makeApp(false)
  const { app } = setup
  const { cookie, device } = await pairWithPasskey(setup)
  expect((await assert(app, device, cookie)).statusCode).toBe(204)
  const refused = await mint(app, cookie)
  expect(refused.statusCode).toBe(403)
  expect(refused.json().error.code).toBe('second_factor_not_enrolled')
})

test('SCORE-011: enrollment requires a discoverable credential and login offers the enrolled ones', async () => {
  const setup = makeApp(true)
  const { app } = setup
  const { cookie, device } = await pairWithPasskey(setup)
  const registration = (
    await post(
      app,
      '/api/session/passkeys/registration-options',
      { password: PASSWORD, label: 'Second' },
      cookie,
    )
  ).json()
  expect(registration.authenticatorSelection).toMatchObject({
    residentKey: 'required',
    requireResidentKey: true,
  })
  // A passkey enrolled before this change (possibly not discoverable) must still be offered to the paired browser;
  // the public sign-in lists nothing.
  const anonymous = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  expect(anonymous.allowCredentials ?? []).toEqual([])
  const options = (
    await post(app, '/api/session/passkey/authentication-options', {}, cookie)
  ).json()
  expect(options.allowCredentials).toEqual([expect.objectContaining({ id: device.id })])
})

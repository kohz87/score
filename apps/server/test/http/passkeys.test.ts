import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { PasskeysSchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { CHALLENGE_TTL_MS, rpIdForOrigin } from '../../src/auth/passkeys.ts'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/pairing.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { SqliteSessionStore } from '../../src/auth/sqlite-session-store.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { SoftAuthenticator } from '../webauthn-authenticator.ts'

const origin = 'https://score.example.ts.net:8741'
const rpId = 'score.example.ts.net'
const headers = { host: 'score.example.ts.net:8741', origin, 'x-score-client': 'web' }
const PASSWORD = 'correct horse battery'
const env = {
  SCORE_REMOTE: '1',
  SCORE_TLS_CERT: '/tmp/cert',
  SCORE_TLS_KEY: '/tmp/key',
  SCORE_PUBLIC_ORIGINS: origin,
}

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function makeApp(extra: Record<string, string> = {}) {
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

async function pair(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token: app.pairing.createToken() },
  })
  expect(response.statusCode).toBe(204)
  return String(response.headers['set-cookie']).split(';')[0]!
}

function post(app: FastifyInstance, url: string, payload: object, cookie?: string, extra = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra },
    payload,
  })
}

async function paired(app: FastifyInstance) {
  const cookie = await pair(app)
  const set = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(set.statusCode).toBe(204)
  return cookie
}

async function registrationOptions(app: FastifyInstance, cookie: string, password = PASSWORD) {
  const response = await post(
    app,
    '/api/session/passkeys/registration-options',
    { password, label: 'Phone' },
    cookie,
  )
  return response
}

async function register(app: FastifyInstance, cookie: string, device = new SoftAuthenticator()) {
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

async function signIn(
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

const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers['set-cookie']).split(';')[0]!

test('registration needs a paired browser and the security password', async () => {
  const { app } = makeApp()
  expect((await registrationOptions(app, '')).statusCode).toBe(401)
  const cookie = await paired(app)
  expect((await registrationOptions(app, cookie, 'wrong password!')).statusCode).toBe(403)
  expect(
    (await post(app, '/api/session/passkeys/registration-options', {}, cookie)).statusCode,
  ).toBeGreaterThanOrEqual(400)
  const ok = await registrationOptions(app, cookie)
  expect(ok.statusCode).toBe(200)
  const options = ok.json()
  expect(options.rp).toEqual({ name: 'Score', id: rpId })
  expect(options.authenticatorSelection).toMatchObject({
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  })
  expect(options.pubKeyCredParams.map((param: { alg: number }) => param.alg)).toEqual([-7, -257])
  // Finishing a registration without having asked for options (no password step) is refused.
  const rogue = new SoftAuthenticator()
  const forged = await post(
    app,
    '/api/session/passkeys',
    { response: rogue.create({ challenge: 'AAAA' }, { origin, rpId }) },
    cookie,
  )
  expect(forged.statusCode).toBe(401)
  expect(
    (
      await post(app, '/api/session/passkeys', {
        response: rogue.create(options, { origin, rpId }),
      })
    ).statusCode,
  ).toBe(401)
})

test('a registered passkey is stored with its metadata and listed', async () => {
  const { app } = makeApp()
  const cookie = await paired(app)
  const device = await register(app, cookie)
  const list = await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })
  const parsed = PasskeysSchema.parse(list.json())
  expect(parsed.available).toBe(true)
  expect(parsed.rpId).toBe(rpId)
  expect(parsed.items).toEqual([
    {
      id: device.id,
      label: 'Phone',
      createdAt: expect.any(String),
      lastUsedAt: null,
      flagged: false,
    },
  ])
})

test('challenges are single-use, expire after five minutes and belong to the session that asked', async () => {
  const { app, advance } = makeApp()
  const cookie = await paired(app)
  const other = await pair(app)
  const device = new SoftAuthenticator()
  const options = (await registrationOptions(app, cookie)).json()
  // Another paired browser can't finish my ceremony (and that burns the challenge).
  const stolen = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(options, { origin, rpId }) },
    other,
  )
  expect(stolen.statusCode).toBe(401)
  const again = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(options, { origin, rpId }) },
    cookie,
  )
  expect(again.statusCode).toBe(401)

  const second = (await registrationOptions(app, cookie)).json()
  const first = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(second, { origin, rpId }) },
    cookie,
  )
  expect(first.statusCode).toBe(201)
  // Reuse after success.
  const replay = await post(
    app,
    '/api/session/passkeys',
    { response: device.create(second, { origin, rpId }) },
    cookie,
  )
  expect(replay.statusCode).toBe(401)

  const late = (await registrationOptions(app, cookie)).json()
  advance(CHALLENGE_TTL_MS)
  const expired = await post(
    app,
    '/api/session/passkeys',
    { response: new SoftAuthenticator().create(late, { origin, rpId }) },
    cookie,
  )
  expect(expired.statusCode).toBe(401)

  // Sign-in challenges follow the same rules.
  const signInOptions = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  const assertion = device.get(signInOptions, { origin, rpId })
  expect(
    (await post(app, '/api/session/passkey/authentication', { response: assertion })).statusCode,
  ).toBe(204)
  expect(
    (await post(app, '/api/session/passkey/authentication', { response: assertion })).statusCode,
  ).toBe(401)
  const staleOptions = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  advance(CHALLENGE_TTL_MS)
  expect(
    (
      await post(app, '/api/session/passkey/authentication', {
        response: device.get(staleOptions, { origin, rpId }),
      })
    ).statusCode,
  ).toBe(401)
})

test('a wrong origin, a wrong RP ID and a missing user verification are refused', async () => {
  const { app } = makeApp()
  const cookie = await paired(app)
  const attempts = [
    { origin: 'https://evil.example.com', rpId },
    { origin, rpId: 'evil.example.com' },
    { origin, rpId, uv: false },
  ]
  for (const attempt of attempts) {
    const options = (await registrationOptions(app, cookie)).json()
    const response = await post(
      app,
      '/api/session/passkeys',
      { response: new SoftAuthenticator().create(options, attempt) },
      cookie,
    )
    expect(response.statusCode).toBe(401)
  }
  // A page on another origin can't borrow the ceremony either: the Origin header must match too.
  const options = (await registrationOptions(app, cookie)).json()
  const foreign = await post(
    app,
    '/api/session/passkeys',
    { response: new SoftAuthenticator().create(options, { origin, rpId }) },
    cookie,
    { origin: 'https://evil.example.com' },
  )
  expect(foreign.statusCode).toBe(403)

  const device = await register(app, cookie)
  for (const attempt of attempts) {
    const response = await signIn(app, device, attempt)
    expect(response.statusCode).toBe(401)
    expect(response.headers['set-cookie']).toBeUndefined()
  }
  expect((await signIn(app, device)).statusCode).toBe(204)
})

test('a sign-count regression is refused and flags the credential', async () => {
  const { app } = makeApp()
  const cookie = await paired(app)
  const device = await register(app, cookie)
  expect((await signIn(app, device, { counter: 5 })).statusCode).toBe(204)
  expect((await signIn(app, device, { counter: 6 })).statusCode).toBe(204)
  expect((await signIn(app, device, { counter: 6 })).statusCode).toBe(401)
  const list = await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })
  expect(list.json().items[0].flagged).toBe(true)
  // Flagged credentials stay refused, even with a counter that would otherwise be fine.
  expect((await signIn(app, device, { counter: 50 })).statusCode).toBe(401)
})

test('two parallel assertions with the same counter cannot both sign in', async () => {
  const { app } = makeApp()
  const device = await register(app, await paired(app))
  const optionsA = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  const optionsB = (await post(app, '/api/session/passkey/authentication-options', {})).json()
  const bodyA = { response: device.get(optionsA, { origin, rpId, counter: 1 }) }
  const bodyB = { response: device.get(optionsB, { origin, rpId, counter: 1 }) }
  const codes = (
    await Promise.all([
      post(app, '/api/session/passkey/authentication', bodyA),
      post(app, '/api/session/passkey/authentication', bodyB),
    ])
  ).map((r) => r.statusCode)
  expect(codes.sort()).toEqual([204, 401])
})

test('authenticators whose counter is always zero keep working', async () => {
  const { app } = makeApp()
  const device = await register(app, await paired(app))
  expect((await signIn(app, device)).statusCode).toBe(204)
  expect((await signIn(app, device)).statusCode).toBe(204)
})

test('a passkey session behaves exactly like a paired one: list, renew, expiry, revoke', async () => {
  const { app, advance } = makeApp()
  const owner = await paired(app)
  const device = await register(app, owner)
  const response = await signIn(app, device)
  expect(response.statusCode).toBe(204)
  expect(response.headers['set-cookie']).toMatch(
    /^score_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/,
  )
  const cookie = cookieOf(response)
  expect(cookie).not.toBe(owner)
  expect(
    (await app.inject({ url: '/api/session', headers: { ...headers, cookie } })).json(),
  ).toEqual({ paired: true })
  const browsers = (
    await app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie } })
  ).json().items
  expect(browsers).toHaveLength(2)
  const mine = browsers.find((browser: { current: boolean }) => browser.current)
  expect(mine.label).toContain('passkey: Phone')

  // Renew gives a fresh 30-day limit.
  advance(5 * 24 * 60 * 60 * 1000)
  await app.inject({ url: '/api/system', headers: { ...headers, cookie: owner } })
  const renewed = await post(
    app,
    `/api/session/browsers/${mine.id}/renew`,
    { password: PASSWORD },
    owner,
  )
  expect(renewed.statusCode).toBe(200)
  expect(Date.parse(renewed.json().expiresAt)).toBeGreaterThan(Date.now())

  // The owner can revoke it, which ends the session at once.
  const revoked = await post(
    app,
    `/api/session/browsers/${mine.id}/revoke`,
    { password: PASSWORD },
    owner,
  )
  expect(revoked.statusCode).toBe(204)
  expect(
    (await app.inject({ url: '/api/session', headers: { ...headers, cookie } })).json(),
  ).toEqual({ paired: false })

  // Idle and absolute expiry are the pairing rules.
  const idle = cookieOf(await signIn(app, device))
  advance(SESSION_IDLE_MS)
  expect(
    (await app.inject({ url: '/api/session', headers: { ...headers, cookie: idle } })).json(),
  ).toEqual({ paired: false })
  const absolute = cookieOf(await signIn(app, device))
  for (let day = 0; day < SESSION_ABSOLUTE_MS / 86_400_000; day += 5) {
    advance(5 * 86_400_000)
    await app.inject({ url: '/api/system', headers: { ...headers, cookie: absolute } })
  }
  expect(
    (await app.inject({ url: '/api/session', headers: { ...headers, cookie: absolute } })).json(),
  ).toEqual({ paired: false })
})

test('removing a passkey needs the password; terminating other pairings keeps passkeys; pairing links still work', async () => {
  const { app } = makeApp()
  const cookie = await paired(app)
  const device = await register(app, cookie)
  const url = `/api/session/passkeys/${device.id}/remove`
  expect((await post(app, url, {}, cookie)).statusCode).toBeGreaterThanOrEqual(400)
  expect(
    (await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })).json()
      .items,
  ).toHaveLength(1)
  expect((await post(app, url, { password: 'wrong password!' }, cookie)).statusCode).toBe(403)
  expect((await post(app, url, { password: PASSWORD })).statusCode).toBe(401)

  const others = await post(
    app,
    '/api/session/browsers/revoke-others',
    { password: PASSWORD },
    cookie,
  )
  expect(others.statusCode).toBe(200)
  expect((await signIn(app, device)).statusCode).toBe(204)

  expect((await post(app, url, { password: PASSWORD }, cookie)).statusCode).toBe(204)
  expect((await signIn(app, device)).statusCode).toBe(401)
  const list = await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })
  expect(list.json().items).toEqual([])
  expect(await pair(app)).toMatch(/^score_session=/)
})

test('sign-in is rate limited like pairing and reveals nothing about which passkeys exist', async () => {
  const { app } = makeApp()
  const device = new SoftAuthenticator()
  const statuses: number[] = []
  for (let i = 0; i < 8; i++) statuses.push((await signIn(app, device)).statusCode)
  expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401])
  expect(statuses).toContain(429)
  // The options step is public too, but answers the same whether or not a passkey exists.
  const options = await post(app, '/api/session/passkey/authentication-options', {})
  expect(options.json().allowCredentials ?? []).toEqual([])
})

test('passkeys are not offered on an IP address, only on a domain name or localhost', async () => {
  expect(rpIdForOrigin('https://192.168.1.20:8741')).toBeNull()
  expect(rpIdForOrigin('https://[::1]:8741')).toBeNull()
  expect(rpIdForOrigin('http://127.0.0.1:5173')).toBeNull()
  expect(rpIdForOrigin('http://score.example.ts.net')).toBeNull()
  expect(rpIdForOrigin('https://hermesvm')).toBeNull()
  expect(rpIdForOrigin('https://score.example.ts.net:8741')).toBe(rpId)
  expect(rpIdForOrigin('http://localhost:5173')).toBe('localhost')

  const lan = 'https://192.168.1.20:8741'
  const { app } = makeApp({ SCORE_PUBLIC_ORIGINS: `${origin},${lan}` })
  const lanHeaders = { ...headers, host: '192.168.1.20:8741', origin: lan }
  const cookie = await paired(app)
  const onLan = await app.inject({
    url: '/api/session/passkeys',
    headers: { ...lanHeaders, cookie },
  })
  expect(onLan.json()).toMatchObject({ available: false, rpId: null })
  const options = await app.inject({
    method: 'POST',
    url: '/api/session/passkeys/registration-options',
    headers: { ...lanHeaders, cookie },
    payload: { password: PASSWORD },
  })
  expect(options.statusCode).toBe(409)
  expect(options.json().error.code).toBe('passkeys_unavailable')
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/session/passkey/authentication-options',
    headers: lanHeaders,
    payload: {},
  })
  expect(signIn.statusCode).toBe(409)
})

// audit4-c 8: the options route is public too and was unlimited.
test('requesting sign-in options over and over is rate limited like the sign-in itself', async () => {
  const { app } = makeApp()
  const statuses: number[] = []
  for (let i = 0; i < 25; i++)
    statuses.push((await post(app, '/api/session/passkey/authentication-options', {})).statusCode)
  expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200])
  expect(statuses.at(-1)).toBe(429)
})

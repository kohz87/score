import { expect, test } from 'vitest'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/auth/pairing.ts'
import {
  PASSWORD,
  cookieOf,
  headers,
  makeApp,
  pair,
  paired,
  post,
  register,
  setupPasskeysTest,
  signIn,
  unlock,
} from './passkeys-helpers.ts'

setupPasskeysTest()

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
  await unlock(app, cookie)
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
  // Later than the test clock's now (start + 5 days), not the wall clock, which has moved past the test's dates.
  expect(Date.parse(renewed.json().expiresAt)).toBeGreaterThan(
    Date.UTC(2026, 9, 9) + 5 * 24 * 60 * 60 * 1000,
  )

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
  await unlock(app, cookie)
  expect(
    (await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })).json()
      .items,
  ).toHaveLength(1)
  await post(app, '/api/session/security/lock', {}, cookie)
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
  await unlock(app, cookie)
  const list = await app.inject({ url: '/api/session/passkeys', headers: { ...headers, cookie } })
  expect(list.json().items).toEqual([])
  expect(await pair(app)).toMatch(/^score_session=/)
})

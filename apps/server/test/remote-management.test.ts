import { PairedBrowsersSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { headers, makeApp, origin, pair, PASSWORD, setPassword, unlock } from './remote-helpers.ts'

test('paired browsers can be listed and revoked over HTTP without exposing credentials', async () => {
  const app = makeApp()
  const first = await pair(app)
  const second = await pair(app)
  // Terminating a pairing needs the security password: first it must be set.
  const anyId = '00000000-0000-4000-8000-000000000000'
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/session/browsers/${anyId}/revoke`,
        headers: { ...headers, cookie: first },
        payload: { password: PASSWORD },
      })
    ).statusCode,
  ).toBe(409)
  // 3.14.2: the list is locked until this browser unlocks the section.
  const listOf = () =>
    app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie: first } })
  await setPassword(app, first)
  expect((await listOf()).statusCode).toBe(403)
  expect((await listOf()).json().error.code).toBe('locked')
  expect((await unlock(app, first, 'not the password')).statusCode).toBe(403)
  expect((await unlock(app, first)).statusCode).toBe(200)
  const list = await listOf()
  expect(list.statusCode).toBe(200)
  const body = PairedBrowsersSchema.parse(list.json())
  expect(body.items).toHaveLength(2)
  expect(JSON.stringify(body)).not.toContain(first.split('=')[1]!)
  const other = body.items.find((item) => !item.current)!
  // Locked again, a wrong password is refused.
  await app.inject({
    method: 'POST',
    url: '/api/session/security/lock',
    headers: { ...headers, cookie: first },
  })
  const terminate = (password?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/session/browsers/${other.id}/revoke`,
      headers: { ...headers, cookie: first },
      payload: password === undefined ? {} : { password },
    })
  expect((await terminate('not the password')).statusCode).toBe(403)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie: second } })).statusCode,
  ).toBe(200)
  const revoke = await terminate(PASSWORD)
  expect(revoke.statusCode).toBe(204)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie: second } })).statusCode,
  ).toBe(401)
  expect((await app.inject({ url: '/api/session/browsers', headers })).statusCode).toBe(401)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/session/browsers/${other.id}/revoke`,
        headers,
        payload: { password: PASSWORD },
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

test('a paired browser can mint a one-time link that pairs a second device exactly once', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  await setPassword(app, cookie)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/session/pairing-links',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(minted.statusCode).toBe(200)
  const { url, expiresAt } = minted.json()
  expect(url.startsWith(`${origin}/pair#`)).toBe(true)
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
  const token = String(url).split('#')[1]
  const second = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token },
  })
  expect(second.statusCode).toBe(204)
  const again = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token },
  })
  expect(again.statusCode).toBe(401)
  // A password sent with one action doesn't unlock the section; listing needs the unlock.
  expect(
    (await app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie } }))
      .statusCode,
  ).toBe(403)
  await unlock(app, cookie)
  const list = await app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie } })
  expect(list.json().items).toHaveLength(2)
  // Unpaired callers cannot mint links.
  expect(
    (await app.inject({ method: 'POST', url: '/api/session/pairing-links', headers })).statusCode,
  ).toBe(401)
})

test('a pairing link can name another configured origin, and only a configured one', async () => {
  const tailscale = 'https://score.tail1234.ts.net'
  const app = makeApp(undefined, { SCORE_PUBLIC_ORIGINS: `${origin},${tailscale}` })
  const cookie = await pair(app)
  await setPassword(app, cookie)
  const mint = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/session/pairing-links',
      headers: { ...headers, cookie },
      payload,
    })
  const security = await app.inject({
    url: '/api/session/security',
    headers: { ...headers, cookie },
  })
  expect(security.json().origins).toEqual([origin, tailscale])
  expect((await mint({ password: PASSWORD })).json().url.startsWith(`${origin}/pair#`)).toBe(true)
  expect(
    (await mint({ password: PASSWORD, origin: tailscale }))
      .json()
      .url.startsWith(`${tailscale}/pair#`),
  ).toBe(true)
  expect((await mint({ password: PASSWORD, origin: 'https://evil.example' })).statusCode).toBe(400)
})

test('Renew gives a browser a fresh 30 days and its next request re-sends the cookie', async () => {
  let now = Date.parse('2026-10-08T00:00:00Z')
  const app = makeApp(() => now)
  const first = await pair(app)
  const other = await pair(app)
  await setPassword(app, first)
  // The first request after pairing re-sends the cookie once; later ones within the hour don't.
  await app.inject({ url: '/api/system', headers: { ...headers, cookie: other } })
  const quiet = await app.inject({ url: '/api/system', headers: { ...headers, cookie: other } })
  expect(quiet.headers['set-cookie']).toBeUndefined()
  // Six days on (inside the 7-day idle limit), renew the other browser from this one.
  now += 6 * 24 * 60 * 60 * 1000
  expect((await unlock(app, first)).statusCode).toBe(200)
  const items = (
    await app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie: first } })
  ).json().items as { id: string; current: boolean; expiresAt: string }[]
  const target = items.find((item) => !item.current)!
  const renewed = await app.inject({
    method: 'POST',
    url: `/api/session/browsers/${target.id}/renew`,
    headers: { ...headers, cookie: first },
    payload: { password: PASSWORD },
  })
  expect(renewed.statusCode).toBe(200)
  const day = 24 * 60 * 60 * 1000
  // Effective expiry is the earlier of the 30-day limit and the 7-day idle limit, both restarted by Renew.
  expect(Date.parse(renewed.json().expiresAt)).toBe(now + 7 * day)
  const next = await app.inject({ url: '/api/system', headers: { ...headers, cookie: other } })
  expect(String(next.headers['set-cookie'])).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
  // Used every six days, the renewed browser is still paired at day 30, when its original 30 days ran out.
  for (let i = 0; i < 4; i++) {
    now += 6 * day
    const used = await app.inject({ url: '/api/system', headers: { ...headers, cookie: other } })
    expect(used.statusCode).toBe(200)
  }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/api/session/browsers/${target.id}/renew`,
        headers,
      })
    ).statusCode,
  ).toBe(401)
})

test('the security password: set once, change needs the current one, wrong guesses are rate-limited', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  const second = await pair(app)
  const put = (payload: object) =>
    app.inject({
      method: 'PUT',
      url: '/api/session/security/password',
      headers: { ...headers, cookie },
      payload,
    })
  const status = async () =>
    (await app.inject({ url: '/api/session/security', headers: { ...headers, cookie } })).json()
  expect(await status()).toMatchObject({ passwordSet: false })
  expect((await put({ password: 'short' })).statusCode).toBe(400)
  await setPassword(app, cookie)
  expect(await status()).toMatchObject({ passwordSet: true })
  // Changing it needs the current password, so a compromised browser can't take it over.
  expect((await put({ password: 'another password' })).statusCode).toBe(403)
  expect((await put({ password: 'another password', current: PASSWORD })).statusCode).toBe(204)
  const others = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/session/browsers/revoke-others',
      headers: { ...headers, cookie },
      payload: { password },
    })
  // The change cleared earlier wrong guesses; five more lock this browser's management out for 15 minutes…
  for (let i = 0; i < 5; i++) expect((await others('wrong guess')).statusCode).toBe(403)
  expect((await others('another password')).statusCode).toBe(429)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie: second } })).statusCode,
  ).toBe(200)
})

test('Terminate all other pairings keeps only the caller', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  const a = await pair(app)
  const b = await pair(app)
  await setPassword(app, cookie)
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/browsers/revoke-others',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(response.json()).toEqual({ revoked: 2 })
  for (const gone of [a, b])
    expect(
      (await app.inject({ url: '/api/system', headers: { ...headers, cookie: gone } })).statusCode,
    ).toBe(401)
  expect(
    (await app.inject({ url: '/api/system', headers: { ...headers, cookie } })).statusCode,
  ).toBe(200)
})

test('checking the security password answers 204 or 403 and counts wrong guesses (5.23)', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  const check = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/session/security/check',
      headers: { ...headers, cookie },
      payload: { password },
    })
  expect((await check(PASSWORD)).statusCode).toBe(409)
  await setPassword(app, cookie)
  expect((await check(PASSWORD)).statusCode).toBe(204)
  for (let i = 0; i < 5; i++) expect((await check('wrong guess')).statusCode).toBe(403)
  expect((await check(PASSWORD)).statusCode).toBe(429)
})

test('3.14.2: Remote access and security unlocks for 5 minutes from the last use, per browser, and locks again', async () => {
  let now = Date.parse('2026-10-28T00:00:00Z')
  const app = makeApp(() => now)
  const first = await pair(app)
  const second = await pair(app)
  const status = async (cookie: string) =>
    (await app.inject({ url: '/api/session/security', headers: { ...headers, cookie } })).json()
  const listOf = (cookie: string) =>
    app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie } })
  // No password yet: nothing to unlock with.
  expect((await unlock(app, first)).statusCode).toBe(409)
  await setPassword(app, first)
  expect(await status(first)).toMatchObject({ unlockedUntil: null })
  const opened = await unlock(app, first)
  expect(opened.json().unlockedUntil).toBe(new Date(now + 5 * 60_000).toISOString())
  // Per browser: the other paired browser stays locked.
  expect((await listOf(second)).statusCode).toBe(403)
  // Each use pushes the end out; reading the status doesn't.
  now += 4 * 60_000
  expect((await listOf(first)).statusCode).toBe(200)
  now += 4 * 60_000
  expect((await status(first)).unlockedUntil).toBe(new Date(now + 60_000).toISOString())
  expect((await listOf(first)).statusCode).toBe(200)
  // Five quiet minutes lock it; an action then needs the password again.
  now += 5 * 60_000 + 1
  expect((await listOf(first)).statusCode).toBe(403)
  const ids = app.pairing.browsers(first)
  const other = ids.find((item) => !item.current)!
  const end = (payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/session/browsers/${other.id}/renew`,
      headers: { ...headers, cookie: first },
      payload,
    })
  expect((await end({})).statusCode).toBeGreaterThanOrEqual(400)
  // Unlocked, actions need no password; Lock now closes it at once.
  await unlock(app, first)
  expect((await end({})).statusCode).toBe(200)
  await app.inject({
    method: 'POST',
    url: '/api/session/security/lock',
    headers: { ...headers, cookie: first },
  })
  expect((await listOf(first)).statusCode).toBe(403)
  // Ending the other devices locks them: their unlock goes with their pairing.
  await unlock(app, second)
  await unlock(app, first)
  await app.inject({
    method: 'POST',
    url: '/api/session/browsers/revoke-others',
    headers: { ...headers, cookie: first },
    payload: {},
  })
  expect(app.pairing.unlockedUntil(second)).toBeNull()
  expect((await unlock(app, second)).statusCode).toBe(401)
  // A sign-out forgets the unlock.
  await unlock(app, first)
  await app.inject({
    method: 'DELETE',
    url: '/api/session',
    headers: { ...headers, cookie: first },
  })
  expect(app.pairing.unlockedUntil(first)).toBeNull()
  // Wrong passwords count against the same limit as every other password check.
  const third = await pair(app)
  for (let i = 0; i < 5; i++) expect((await unlock(app, third, 'wrong guess')).statusCode).toBe(403)
  expect((await unlock(app, third)).statusCode).toBe(429)
})

test('3.14.2: setting the first password opens the section for that browser', async () => {
  const app = makeApp()
  const cookie = await pair(app)
  const put = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers: { ...headers, cookie },
    payload: { password: PASSWORD },
  })
  expect(put.statusCode).toBe(204)
  expect(
    (await app.inject({ url: '/api/session/browsers', headers: { ...headers, cookie } }))
      .statusCode,
  ).toBe(200)
})

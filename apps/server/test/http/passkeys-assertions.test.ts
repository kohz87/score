import { expect, test } from 'vitest'
import { SoftAuthenticator } from '../webauthn-authenticator.ts'
import {
  headers,
  makeApp,
  origin,
  paired,
  post,
  registrationOptions,
  register,
  rpId,
  setupPasskeysTest,
  signIn,
  unlock,
} from './passkeys-helpers.ts'

setupPasskeysTest()

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
  await unlock(app, cookie)
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

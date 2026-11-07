import { expect, test } from 'vitest'
import { PasskeysSchema } from '@score/contract'
import { CHALLENGE_TTL_MS } from '../../src/auth/passkeys.ts'
import { SoftAuthenticator } from '../webauthn-authenticator.ts'
import {
  headers,
  makeApp,
  origin,
  pair,
  paired,
  post,
  registrationOptions,
  register,
  rpId,
  setupPasskeysTest,
  unlock,
} from './passkeys-helpers.ts'

setupPasskeysTest()

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
  await unlock(app, cookie)
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

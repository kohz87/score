import { expect, test } from 'vitest'
import { SoftAuthenticator } from '../webauthn-authenticator.ts'
import { makeApp, post, setupPasskeysTest, signIn } from './passkeys-helpers.ts'

setupPasskeysTest()

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

// audit4-c 8: the options route is public too and was unlimited.
test('requesting sign-in options over and over is rate limited like the sign-in itself', async () => {
  const { app } = makeApp()
  const statuses: number[] = []
  for (let i = 0; i < 25; i++)
    statuses.push((await post(app, '/api/session/passkey/authentication-options', {})).statusCode)
  expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200])
  expect(statuses.at(-1)).toBe(429)
})

import { expect, test } from 'vitest'
import { rpIdForOrigin } from '../../src/auth/passkeys.ts'
import {
  PASSWORD,
  headers,
  makeApp,
  origin,
  paired,
  rpId,
  setupPasskeysTest,
  unlock,
} from './passkeys-helpers.ts'

setupPasskeysTest()

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
  await unlock(app, cookie)
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

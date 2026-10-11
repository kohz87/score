import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { SESSION_MAX_AGE } from '../src/auth/cookies.ts'
import { humanGuard } from '../src/auth/human.ts'
import { PAIRING_TTL_MS } from '../src/auth/pairing.ts'
import { loadConfig } from '../src/config.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function createApp(clock?: () => number): FastifyInstance {
  const app = buildApp({ config: loadConfig({}), logger: false, clock })
  apps.push(app)
  app.post('/api/test-human', { preHandler: humanGuard(app.pairing) }, async () => ({ ok: true }))
  return app
}

async function pair(app: FastifyInstance, token = app.pairing.createToken()) {
  return app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web', origin: 'http://127.0.0.1:5173' },
    payload: { token },
  })
}

function cookieFrom(response: Awaited<ReturnType<typeof pair>>): string {
  const header = response.headers['set-cookie']
  expect(typeof header).toBe('string')
  const cookie = String(header).split(';', 1)[0]
  if (!cookie) throw new Error('Session cookie missing')
  return cookie
}

test('pairing sets the expected cookie, updates session status and unlocks H routes', async () => {
  const app = createApp()
  const before = await app.inject('/api/session')
  expect(before.json()).toEqual({ paired: false })

  const token = app.pairing.createToken()
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  const response = await pair(app, token)
  expect(response.statusCode).toBe(204)
  expect(response.body).toBe('')
  expect(response.headers['set-cookie']).toMatch(
    /^score_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/,
  )
  expect(response.headers['set-cookie']).not.toContain('Secure')
  const cookie = cookieFrom(response)
  const id = cookie.slice('score_session='.length)
  expect(Buffer.from(id, 'base64url')).toHaveLength(32)
  expect(id).not.toBe(token)
  const after = await app.inject({ url: '/api/session', headers: { cookie } })
  expect(after.statusCode).toBe(200)
  expect(after.json()).toEqual({ paired: true })
  const human = await app.inject({
    method: 'POST',
    url: '/api/test-human',
    headers: { 'x-score-client': 'web', cookie },
  })
  expect(human.statusCode).toBe(200)
})

test('a consumed token cannot be reused, including concurrent requests', async () => {
  const app = createApp()
  const token = app.pairing.createToken()
  const responses = await Promise.all([pair(app, token), pair(app, token)])
  expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 401])
  const replay = await pair(app, token)
  expect(replay.statusCode).toBe(401)
  expect(replay.json()).toEqual({
    error: {
      code: 'pairing_failed',
      message: 'This pairing link is invalid or has expired. Get a new one in the server terminal.',
    },
  })
  expect(replay.headers['set-cookie']).toBeUndefined()
})

test.each(['', 'bad-token', 'a'.repeat(43)])(
  'bad token %j is rejected without consuming the valid token',
  async (token) => {
    const app = createApp()
    const valid = app.pairing.createToken()
    const response = await pair(app, token)
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('pairing_failed')
    expect((await pair(app, valid)).statusCode).toBe(204)
  },
)

test('no token is available until startup issues one', async () => {
  const response = await pair(createApp(), 'unissued-token')
  expect(response.statusCode).toBe(401)
})

test('pairing token expires at exactly 15 minutes with an injected clock', async () => {
  let now = 1000
  const app = createApp(() => now)
  const token = app.pairing.createToken()
  now += PAIRING_TTL_MS
  const response = await pair(app, token)
  expect(response.statusCode).toBe(401)
  expect(response.json().error.code).toBe('pairing_failed')
  expect(response.headers['set-cookie']).toBeUndefined()
})

test('pairing token is valid just before expiry', async () => {
  let now = 1000
  const app = createApp(() => now)
  const token = app.pairing.createToken()
  now += PAIRING_TTL_MS - 1
  expect((await pair(app, token)).statusCode).toBe(204)
})

test('DELETE revokes the session, clears the cookie and locks H routes', async () => {
  const app = createApp()
  const cookie = cookieFrom(await pair(app))
  const response = await app.inject({
    method: 'DELETE',
    url: '/api/session',
    headers: { 'x-score-client': 'web', cookie },
  })
  expect(response.statusCode).toBe(204)
  expect(response.body).toBe('')
  expect(response.headers['set-cookie']).toBe(
    'score_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
  )
  const session = await app.inject({ url: '/api/session', headers: { cookie } })
  expect(session.json()).toEqual({ paired: false })
  const human = await app.inject({
    method: 'POST',
    url: '/api/test-human',
    headers: { 'x-score-client': 'web', cookie },
  })
  expect(human.statusCode).toBe(401)
  expect(human.json().error.code).toBe('not_paired')
})

test('CSRF rejection cannot revoke or consume credentials', async () => {
  const app = createApp()
  const token = app.pairing.createToken()
  const blocked = await app.inject({ method: 'POST', url: '/api/session/pair', payload: { token } })
  expect(blocked.statusCode).toBe(403)
  const cookie = cookieFrom(await pair(app, token))
  const logout = await app.inject({ method: 'DELETE', url: '/api/session', headers: { cookie } })
  expect(logout.statusCode).toBe(403)
  expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: true,
  })
})

test('server enforces the session cookie lifetime', async () => {
  let now = 1000
  const app = createApp(() => now)
  const cookie = cookieFrom(await pair(app))
  now += SESSION_MAX_AGE * 1000
  expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: false,
  })
})

test.each(['score_session=forged', 'score_session=%broken', 'other=value'])(
  'invalid session cookie %s never grants human access',
  async (cookie) => {
    const app = createApp()
    const status = await app.inject({ url: '/api/session', headers: { cookie } })
    expect(status.json()).toEqual({ paired: false })
    const response = await app.inject({
      method: 'POST',
      url: '/api/test-human',
      headers: { 'x-score-client': 'web', cookie },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error.code).toBe('not_paired')
  },
)

test('sessions are lost on restart and new startup tokens invalidate the previous token', async () => {
  const app = createApp()
  const previous = app.pairing.createToken()
  const current = app.pairing.createToken()
  expect((await pair(app, previous)).statusCode).toBe(401)
  const cookie = cookieFrom(await pair(app, current))
  expect((await createApp().inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({
    paired: false,
  })
})

test('cookie parsing supports other cookies and rejects duplicate credentials', async () => {
  const app = createApp()
  const cookie = cookieFrom(await pair(app))
  const valid = await app.inject({
    url: '/api/session',
    headers: { cookie: `other=1; ${cookie}; last=2` },
  })
  expect(valid.json()).toEqual({ paired: true })
  const duplicate = await app.inject({
    url: '/api/session',
    headers: { cookie: `${cookie}; ${cookie}` },
  })
  expect(duplicate.json()).toEqual({ paired: false })
})

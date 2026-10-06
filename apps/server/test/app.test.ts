import type { FastifyInstance } from 'fastify'
import { SystemStatusSchema } from '@score/contract'
import { afterEach, expect, test } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../src/app.ts'
import { humanGuard } from '../src/auth/human.ts'
import { loadConfig } from '../src/config.ts'
import { HttpError } from '../src/errors.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function createApp(mode: 'fake' | 'live' = 'fake'): FastifyInstance {
  const app = buildApp({ config: loadConfig({ SCORE_MODE: mode }), logger: false })
  apps.push(app)
  return app
}

test('zod validation errors return the contract 400 shape', async () => {
  const app = createApp()
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: 42 },
  })
  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: { code: 'bad_request', message: 'Invalid request' } })
})

test('malformed JSON returns the contract 400 shape', async () => {
  const response = await createApp().inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web', 'content-type': 'application/json' },
    payload: '{"token":',
  })
  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: { code: 'bad_request', message: 'Invalid request' } })
})

test('Fastify schema validation returns the contract 400 shape', async () => {
  const app = createApp()
  app.get(
    '/test/schema',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    },
    async () => ({ ok: true }),
  )
  const response = await app.inject('/test/schema')
  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: { code: 'bad_request', message: 'Invalid request' } })
})

test('unknown routes return the contract 404 shape', async () => {
  const response = await createApp().inject('/api/unknown')
  expect(response.statusCode).toBe(404)
  expect(response.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } })
})

test('unexpected errors return a sanitized 500 shape', async () => {
  const app = createApp()
  app.get('/test/error', async () => {
    throw new Error('sensitive internal message')
  })
  const response = await app.inject('/test/error')
  expect(response.statusCode).toBe(500)
  expect(response.json()).toEqual({ error: { code: 'internal', message: 'Internal server error' } })
  expect(response.body).not.toContain('sensitive')
  expect(response.body).not.toContain('stack')
})

test('HttpError preserves explicit status, code and details', async () => {
  const app = createApp()
  app.get('/test/conflict', async () => {
    throw new HttpError(409, 'conflict', 'Resource changed', { revision: 2 })
  })
  const response = await app.inject('/test/conflict')
  expect(response.statusCode).toBe(409)
  expect(response.json()).toEqual({
    error: { code: 'conflict', message: 'Resource changed', details: { revision: 2 } },
  })
})

test.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
  '%s under /api/ requires X-Score-Client before parsing the body',
  async (method) => {
    const app = createApp()
    app.route({ method, url: '/api/test-mutation', handler: async () => ({ ok: true }) })
    const response = await app.inject({
      method,
      url: '/api/test-mutation?query=1',
      headers: { 'content-type': 'application/json' },
      payload: '{invalid',
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: { code: 'forbidden', message: 'Request origin or client is not allowed' },
    })
  },
)

test.each([
  { 'x-score-client': 'other' },
  { 'x-score-client': 'web', origin: 'https://untrusted.example' },
  { 'x-score-client': 'web', origin: 'http://127.0.0.1:5173.untrusted.example' },
  { 'x-score-client': 'web', origin: 'null' },
])('rejects disallowed mutation headers %j', async (headers) => {
  const response = await createApp().inject({ method: 'DELETE', url: '/api/session', headers })
  expect(response.statusCode).toBe(403)
  expect(response.json().error.code).toBe('forbidden')
})

test.each(['/api/%73ession', '/%61pi/session', '/api%2fsession'])(
  'encoded route %s cannot bypass the CSRF guard',
  async (url) => {
    const response = await createApp().inject({ method: 'DELETE', url })
    expect([403, 404]).toContain(response.statusCode)
  },
)

test.each([undefined, 'http://127.0.0.1:5173', 'http://127.0.0.1:8740'])(
  'accepts an allowed origin %s with the client header',
  async (origin) => {
    const response = await createApp().inject({
      method: 'DELETE',
      url: '/api/session',
      headers: { 'x-score-client': 'web', ...(origin === undefined ? {} : { origin }) },
    })
    expect(response.statusCode).toBe(204)
  },
)

test('CSRF guard does not cover bridge requests or reads', async () => {
  const app = createApp()
  app.post('/bridge/test', async () => ({ ok: true }))
  const bridge = await app.inject({ method: 'POST', url: '/bridge/test' })
  expect(bridge.statusCode).toBe(200)
  const read = await app.inject({
    url: '/api/session',
    headers: { origin: 'https://untrusted.example' },
  })
  expect(read.statusCode).toBe(200)
})

test('human guard requires pairing and runs after CSRF', async () => {
  const app = createApp()
  app.post('/api/test-human', { preHandler: humanGuard(app.pairing) }, async () => ({ ok: true }))
  const missingCsrf = await app.inject({ method: 'POST', url: '/api/test-human' })
  expect(missingCsrf.statusCode).toBe(403)
  const response = await app.inject({
    method: 'POST',
    url: '/api/test-human',
    headers: { 'x-score-client': 'web' },
  })
  expect(response.statusCode).toBe(401)
  expect(response.json()).toEqual({
    error: { code: 'not_paired', message: 'Pair this browser to make human decisions' },
  })
})

test('human routes are only registered in tests', async () => {
  const response = await createApp().inject('/api/test-human')
  expect(response.statusCode).toBe(404)
})

test.each(['fake', 'live'] as const)(
  'GET /api/system validates and reports config mode %s',
  async (mode) => {
    const response = await createApp(mode).inject('/api/system')
    expect(response.statusCode).toBe(200)
    const status = SystemStatusSchema.parse(response.json())
    expect(status.mode).toBe(mode)
    expect(status.hermes.reachable).toBe(mode === 'fake')
    expect(status.agentIsolation).toBe('same_user')
  },
)

test('zod errors do not echo supplied values', async () => {
  const app = createApp()
  app.get('/test/zod', async () => z.enum(['allowed']).parse('secret-token'))
  const response = await app.inject('/test/zod')
  expect(response.statusCode).toBe(400)
  expect(response.body).not.toContain('secret-token')
})

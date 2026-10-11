import type { FastifyInstance } from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

const apps: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function createApp(env: Record<string, string> = {}): FastifyInstance {
  const app = buildApp({ config: loadConfig(env), logger: false })
  apps.push(app)
  return app
}

async function mutate(app: FastifyInstance, origin: string) {
  return app.inject({
    method: 'DELETE',
    url: '/api/session',
    headers: { 'x-score-client': 'web', origin },
  })
}

const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']

test.each(loopbackHosts)('web origin using %s accepts all three loopback aliases', async (host) => {
  const app = createApp({ SCORE_WEB_ORIGIN: `https://${host}:5173` })
  for (const alias of loopbackHosts) {
    expect((await mutate(app, `https://${alias}:5173`)).statusCode).toBe(204)
  }
})

test.each(['127.0.0.1', 'localhost', '::1'])(
  'server origin using %s accepts all three loopback aliases',
  async (host) => {
    const app = createApp({ SCORE_HOST: host })
    for (const alias of loopbackHosts) {
      expect((await mutate(app, `http://${alias}:8740`)).statusCode).toBe(204)
    }
  },
)

test('non-loopback origins remain exact matches without loopback aliases', async () => {
  const app = createApp({
    SCORE_WEB_ORIGIN: 'https://web.example:5173',
  })
  expect((await mutate(app, 'https://web.example:5173')).statusCode).toBe(204)
  expect((await mutate(app, 'http://server.example:8740')).statusCode).toBe(403)
  for (const alias of loopbackHosts) {
    expect((await mutate(app, `https://${alias}:5173`)).statusCode).toBe(403)
  }
})

test.each([
  'https://localhost:5173',
  'http://localhost:5174',
  'https://[::1]:8740',
  'http://127.0.0.2:5173',
  'http://localhost.example:5173',
  'http://[::2]:5173',
])('loopback aliases reject a different scheme, port or hostname: %s', async (origin) => {
  expect((await mutate(createApp(), origin)).statusCode).toBe(403)
})

test('SCORE-030: local mode answers only requests addressed to loopback names on its own ports (reads included)', async () => {
  const app = createApp({ SCORE_PORT: '8750', SCORE_WEB_ORIGIN: 'http://127.0.0.1:5199' })
  const get = (host: string, url = '/api/health') =>
    app.inject({ method: 'GET', url, headers: { host } }).then((res) => res.statusCode)
  for (const host of [
    '127.0.0.1:8750',
    'localhost:8750',
    '[::1]:8750',
    'LOCALHOST:8750',
    '127.0.0.1:5199',
    'localhost:5199',
  ])
    expect(await get(host), host).toBe(200)
  for (const host of [
    'rebind.example:8750',
    'rebind.example',
    '127.0.0.1:9999',
    '127.0.0.1',
    'localhost.example:8750',
    '127.0.0.1:8750.evil.example',
  ])
    expect(await get(host), host).toBe(403)
  expect(await get('rebind.example:8750', '/api/rooms')).toBe(403)
})

test('SCORE-030: a custom web origin host is allowed in local mode', async () => {
  const app = createApp({ SCORE_WEB_ORIGIN: 'https://web.example:5173' })
  const res = await app.inject({
    method: 'GET',
    url: '/api/health',
    headers: { host: 'web.example:5173' },
  })
  expect(res.statusCode).toBe(200)
})

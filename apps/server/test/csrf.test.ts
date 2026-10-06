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
    SCORE_HOST: 'server.example',
    SCORE_WEB_ORIGIN: 'https://web.example:5173',
  })
  expect((await mutate(app, 'https://web.example:5173')).statusCode).toBe(204)
  expect((await mutate(app, 'http://server.example:8740')).statusCode).toBe(204)
  for (const alias of loopbackHosts) {
    expect((await mutate(app, `https://${alias}:5173`)).statusCode).toBe(403)
    expect((await mutate(app, `http://${alias}:8740`)).statusCode).toBe(403)
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

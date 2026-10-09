import fs from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
const headers = { 'x-score-client': 'web' }

beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  await port.start(env.ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
  })
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})

async function cookie() {
  const token = app.pairing.createToken()
  const response = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers,
    payload: { token },
  })
  return String(response.headers['set-cookie']).split(';')[0]!
}

test('defaults to USD, saves a code and manual rate for paired browsers, and persists it', async () => {
  expect((await app.inject('/api/settings/currency')).json()).toEqual({ code: 'USD', rate: 1 })
  const put = (payload: unknown, session?: string) =>
    app.inject({
      method: 'PUT',
      url: '/api/settings/currency',
      headers: { ...headers, ...(session ? { cookie: session } : {}) },
      payload: payload as object,
    })
  expect((await put({ code: 'EUR', rate: 0.92 })).statusCode).toBe(401)
  const session = await cookie()
  expect((await put({ code: 'EUR', rate: 0.92 }, session)).json()).toEqual({
    code: 'EUR',
    rate: 0.92,
  })
  expect((await app.inject('/api/settings/currency')).json()).toEqual({ code: 'EUR', rate: 0.92 })
  // USD is the base: whatever rate is sent, it is stored as 1.
  expect((await put({ code: 'USD', rate: 5 }, session)).json()).toEqual({ code: 'USD', rate: 1 })
  for (const bad of [
    { code: 'euro', rate: 1 },
    { code: 'EUR', rate: 0 },
    { code: 'EUR', rate: -2 },
    { code: 'EUR' },
  ])
    expect((await put(bad, session)).statusCode).toBe(400)
})

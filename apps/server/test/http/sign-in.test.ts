import fs from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, expect, test } from 'vitest'
import { ProviderItemSchema, SignInSchema, ConnectResultSchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

const KEY = 'sk-sentinel-4f9a1c7e-not-a-real-key'
let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let headers: Record<string, string>
let logs: string
async function boot(plainHttpRemote: boolean) {
  env = setup()
  logs = ''
  port = new FakePort(1, { db: env.db }, false)
  await port.start(env.ingest)
  const config = loadConfig({ SCORE_MODE: 'fake' })
  const base: Record<string, string> = plainHttpRemote
    ? { host: '192.168.1.5:8741', origin: 'http://192.168.1.5:8741', 'x-score-client': 'web' }
    : { 'x-score-client': 'web' }
  app = buildApp({
    // Simulates plain-HTTP remote mode without binding a LAN address.
    config: plainHttpRemote
      ? loadConfig({
          SCORE_MODE: 'fake',
          SCORE_REMOTE: '1',
          SCORE_HOST: '192.168.1.5',
          SCORE_PUBLIC_ORIGINS: 'http://192.168.1.5:8741',
          SCORE_REMOTE_INSECURE_HTTP: 'accept',
        })
      : config,
    logger: {
      level: 'trace',
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs += String(chunk)
          done()
        },
      }),
    },
    port,
    db: env.db,
    ingest: env.ingest,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: base,
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    ...base,
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
}
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})
const post = (url: string, payload?: object, extra: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...extra },
    ...(payload ? { payload } : {}),
  })

test('a device sign-in starts, is followed, and connects; cancel works and unknown ids are 404', async () => {
  await boot(false)
  const started = ConnectResultSchema.parse(
    (await post('/api/settings/providers/nous/connect')).json(),
  )
  expect(started).toMatchObject({ next: 'device_code', url: 'https://example.com/device' })
  expect(started.code).toBeTruthy()
  // A second connect while waiting returns the same sign-in.
  expect(
    ConnectResultSchema.parse((await post('/api/settings/providers/nous/connect')).json()).signInId,
  ).toBe(started.signInId)
  const url = `/api/settings/sign-ins/${started.signInId}`
  // The fake approves on the third status read.
  for (let read = 1; read < 3; read++)
    expect(SignInSchema.parse((await app.inject(url)).json()).state).toBe('waiting')
  expect(SignInSchema.parse((await app.inject(url)).json())).toMatchObject({
    state: 'connected',
    url: null,
    code: null,
  })
  const providers = (await app.inject('/api/settings/providers')).json().items as {
    id: string
    status: string
    signIn: string
  }[]
  expect(providers.find((p) => p.id === 'nous')).toMatchObject({
    status: 'connected',
    signIn: 'device_code',
  })
  expect(providers.find((p) => p.id === 'openrouter')!.signIn).toBe('api_key')
  expect(providers.find((p) => p.id === 'anthropic')!.signIn).toBe('terminal')

  const again = ConnectResultSchema.parse(
    (await post('/api/settings/providers/nous/connect')).json(),
  )
  const cancel = await app.inject({
    method: 'DELETE',
    url: `/api/settings/sign-ins/${again.signInId}`,
    headers,
  })
  expect(SignInSchema.parse(cancel.json()).state).toBe('cancelled')
  expect((await app.inject('/api/settings/sign-ins/nope')).statusCode).toBe(404)
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/settings/sign-ins/${again.signInId}` }))
      .statusCode,
  ).toBeGreaterThanOrEqual(401)
  expect((await post('/api/settings/providers/anthropic/connect')).json().next).toBe(
    'run_in_terminal',
  )
})

test('the key route needs a human, a key provider, and a valid body', async () => {
  await boot(false)
  const url = '/api/settings/providers/openrouter/key'
  expect(
    (await app.inject({ method: 'POST', url, payload: { apiKey: KEY } })).statusCode,
  ).toBeGreaterThanOrEqual(401)
  const ok = await post(url, { apiKey: KEY, label: 'work' })
  expect(ok.statusCode).toBe(200)
  expect(ProviderItemSchema.parse(ok.json())).toMatchObject({
    id: 'openrouter',
    status: 'connected',
  })
  expect((await post('/api/settings/providers/anthropic/key', { apiKey: KEY })).statusCode).toBe(
    409,
  )
  expect((await post('/api/settings/providers/nope/key', { apiKey: KEY })).statusCode).toBe(404)
  for (const bad of [
    {},
    { apiKey: 'short' },
    { apiKey: 'has space in it 123' },
    { apiKey: KEY, x: 1 },
  ])
    expect((await post(url, bad)).statusCode).toBe(400)
})

test('plain-HTTP remote refuses a key without the acknowledgement', async () => {
  await boot(true)
  const url = '/api/settings/providers/openrouter/key'
  const refused = await post(url, { apiKey: KEY })
  expect(refused.statusCode).toBe(400)
  expect(refused.json().error.code).toBe('insecure_transport')
  expect((await post(url, { apiKey: KEY, acknowledgeInsecure: false })).statusCode).toBe(400)
  expect((await post(url, { apiKey: KEY, acknowledgeInsecure: true })).statusCode).toBe(200)
})

test('no trace of the key in responses, logs, the database or the receipt', async () => {
  await boot(false)
  const url = '/api/settings/providers/openrouter/key'
  const bodies = [
    await post(url, { apiKey: KEY }, { 'idempotency-key': 'key-1' }),
    // A replay answers from the receipt.
    await post(url, { apiKey: KEY }, { 'idempotency-key': 'key-1' }),
    // Invalid shapes carrying the sentinel (extra field, bad length) fail without echoing it.
    await post(url, { apiKey: KEY, extra: KEY }, { 'idempotency-key': 'key-2' }),
    await post(url, { apiKey: `${KEY} ${KEY}` }),
    await post(url, { apiKey: KEY, label: `${KEY}!!` }),
  ]
  expect(bodies.map((response) => response.statusCode)).toEqual([200, 200, 400, 400, 400])
  for (const response of bodies) {
    expect(response.body).not.toContain(KEY)
    expect(JSON.stringify(response.headers)).not.toContain(KEY)
  }
  // The same key under a different Idempotency-Key is a new request; a changed body under the same key conflicts.
  expect((await post(url, { apiKey: `${KEY}2` }, { 'idempotency-key': 'key-1' })).statusCode).toBe(
    409,
  )
  const receipts = env.db.sqlite.prepare('SELECT * FROM request_receipts').all()
  expect(receipts.length).toBeGreaterThan(0)
  expect(JSON.stringify(receipts)).not.toContain(KEY)
  // The stored hash is not the plain SHA-256 of the body, so it can't confirm a guess.
  const { createHash } = await import('node:crypto')
  const plain = createHash('sha256')
    .update(`{"apiKey":${JSON.stringify(KEY)}}`)
    .digest('hex')
  expect(JSON.stringify(receipts)).not.toContain(plain)
  expect(logs.length).toBeGreaterThan(0)
  expect(logs).not.toContain(KEY)
  env.db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  for (const name of fs.readdirSync(env.home, { recursive: true, encoding: 'utf8' })) {
    const path = join(env.home, name)
    if (fs.statSync(path).isFile()) expect(fs.readFileSync(path).includes(KEY), name).toBe(false)
  }
})

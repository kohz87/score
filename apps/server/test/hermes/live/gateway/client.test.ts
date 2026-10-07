import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GatewayClient, HermesHttpError } from '../../../../src/hermes/live/gateway.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

test.each(['default', 'builder'])(
  '%s has its own auth, endpoint scope, idempotency and control requests (L3)',
  async (profile) => {
    const request = {
      profile,
      input: 'hello',
      model: 'fixture-model',
      sessionId: 'fixture-session',
    }
    const admission = await env.gateway.startRun(request, 'client-turn')
    expect(admission.replayed).toBe(false)
    expect(await env.gateway.startRun(request, 'client-turn')).toEqual({
      runId: admission.runId,
      replayed: true,
    })
    expect(await env.gateway.getRun(profile, admission.runId)).toMatchObject({
      status: 'running',
      last_event: 'run.started',
    })
    await env.gateway.stopRun(profile, admission.runId)
    await env.gateway.steerRun(profile, admission.runId, 'continue carefully')
    expect(
      await env.gateway.submitApproval(profile, {
        runId: admission.runId,
        choice: 'deny',
        requestId: 'fixture-request',
      }),
    ).toBe('not_pending')
    expect(await env.gateway.capabilities(profile)).toMatchObject({ run_submission: true })
    expect(await env.gateway.health()).toMatchObject({ status: 'ok' })
    const prefix = profile === 'default' ? '' : `/p/${profile}`
    expect(env.fake.calls[0]).toMatchObject({
      path: `${prefix}/v1/runs`,
      body: { input: 'hello', model: 'fixture-model', session_id: 'fixture-session' },
    })
    expect(env.fake.calls.find((call) => call.path.endsWith('/steer'))?.body).toEqual({
      input: 'continue carefully',
    })
    const other = profile === 'default' ? 'builder' : 'default'
    await expect(env.gateway.getRun(other, admission.runId)).rejects.toMatchObject({
      status: 404,
      code: 'run_not_found',
    })
  },
)

test('fake gateway rejects wrong bearer key and conflicting idempotency payload', async () => {
  const { runId } = await env.gateway.startRun(
    { profile: 'builder', input: 'one' },
    'conflict-turn',
  )
  await expect(
    env.gateway.startRun({ profile: 'builder', input: 'two' }, 'conflict-turn'),
  ).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
  env.fake.keys.set('builder', 'different-server-key')
  await expect(env.gateway.getRun('builder', runId)).rejects.toMatchObject({
    status: 401,
    code: 'gateway_auth_failed',
  })
  expect(env.fake.creations).toBe(1)
})

test('malformed responses and error bodies never appear in typed errors', async () => {
  for (const response of [
    Response.json({ run_id: 'run', status: 'unknown', replayed: true }, { status: 202 }),
    Response.json({ error: 'sensitive arbitrary error' }, { status: 500 }),
    new Response('invalid json fixture', { status: 200 }),
  ]) {
    const client = new GatewayClient({
      scoreHome: env.home,
      db: env.db,
      fetch: async () => response,
    })
    const error = await client
      .startRun({ profile: 'builder', input: 'hello' }, 'error-turn')
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(HermesHttpError)
    expect(String(error)).not.toMatch(/sensitive|invalid json fixture|unknown/)
    expect(error).not.toHaveProperty('body')
  }
})

test('health needs no credential, profiles and gateway origins are validated before fetch', async () => {
  const client = new GatewayClient({
    scoreHome: '/missing-fixture-home',
    db: env.db,
    fetch: env.fake.fetch,
  })
  expect(await client.health()).toMatchObject({ status: 'ok' })
  const before = env.fake.calls.length
  await expect(
    env.gateway.startRun({ profile: '../outside', input: 'hello' }, 'turn'),
  ).rejects.toThrow()
  expect(env.fake.calls).toHaveLength(before)
  for (const baseUrl of ['http://user:pass@localhost', 'http://localhost/path', 'file:///tmp/fake'])
    expect(() => new GatewayClient({ scoreHome: env.home, db: env.db, baseUrl })).toThrow(
      'gateway origin',
    )
})

test('JSON request aborts at 10 seconds', async () => {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    return controller.signal
  })
  const client = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  })
  const pending = expect(client.health()).rejects.toMatchObject({ code: 'transport_error' })
  await vi.advanceTimersByTimeAsync(10_000)
  await pending
})

test('real HTTP transport enforces bearer and idempotency and streams a fixture', async (context) => {
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers))
      if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value)
    const result = await env.fake.fetch(`http://localhost${request.url}`, {
      method: request.method ?? 'GET',
      headers,
      ...(body ? { body } : {}),
    })
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip()
      return
    }
    throw error
  }
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const client = new GatewayClient({
      scoreHome: env.home,
      db: env.db,
      baseUrl: `http://127.0.0.1:${address.port}`,
    })
    const { runId } = await client.startRun(
      { profile: 'builder', input: 'TCP fixture' },
      'tcp-turn',
    )
    expect(await client.startRun({ profile: 'builder', input: 'TCP fixture' }, 'tcp-turn')).toEqual(
      { runId, replayed: true },
    )
    const frames = []
    for await (const frame of client.runEvents('builder', runId)) frames.push(frame)
    expect(frames).toHaveLength(env.fake.events.length + 1)
    expect(env.fake.creations).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

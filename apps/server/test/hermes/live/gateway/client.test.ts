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
      provider: 'fixture-provider',
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
      body: {
        input: 'hello',
        model: 'fixture-model',
        provider: 'fixture-provider',
        session_id: 'fixture-session',
      },
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

test.each([0, 1, 2])('approval resolved=%i requires exactly one target', async (resolved) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(JSON.stringify({ resolved }), { status: 200 }))
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  const request = { runId: 'run-exact', requestId: 'request-exact', choice: 'once' as const }
  if (resolved === 1) expect(await client.submitApproval('builder', request, 1)).toBe('applied')
  else
    await expect(client.submitApproval('builder', request, 1)).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
      maybeApplied: true,
    })
  // The run's projection is read first (0.22.5 needs its execution generation); this one has none.
  expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8642/p/builder/v1/runs/run-exact')
  expect(fetch.mock.calls[1]?.[0]).toBe(
    'http://127.0.0.1:8642/p/builder/v1/runs/run-exact/approval',
  )
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
    choice: 'once',
    request_id: 'request-exact',
  })
})

test('Hermes 0.22.5 under its session authority gets exactly {request_id, execution_generation, choice}', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/approval')
      ? new Response(JSON.stringify({ status: 'resolved', prompt_id: 'prompt-7' }), { status: 200 })
      : new Response(JSON.stringify({ status: 'started', execution_generation: 3 }), {
          status: 200,
        }),
  )
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  expect(
    await client.submitApproval(
      'builder',
      { runId: 'run-a', requestId: 'prompt-7', choice: 'deny' },
      1,
    ),
  ).toBe('applied')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
    request_id: 'prompt-7',
    execution_generation: 3,
    choice: 'deny',
  })
})

test.each([
  ['already_resolved', 200, { status: 'already_resolved', prompt_id: 'p' }],
  ['stale_generation', 409, { error: { code: 'stale_generation' } }],
])('a 0.22.5 %s answer is not_pending', async (_name, status, payload) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/approval')
      ? new Response(JSON.stringify(payload), { status })
      : new Response(JSON.stringify({ execution_generation: 1 }), { status: 200 }),
  )
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  expect(
    await client.submitApproval('builder', { runId: 'run-b', requestId: 'p', choice: 'once' }, 1),
  ).toBe('not_pending')
})
test.each(['approval_not_pending', 'approval_not_active'])(
  'approval %s is not_pending',
  async (code) => {
    const client = new GatewayClient({
      scoreHome: env.home,
      db: env.db,
      fetch: async () => new Response(JSON.stringify({ error: { code } }), { status: 409 }),
    })
    expect(
      await client.submitApproval('builder', {
        runId: 'run',
        requestId: 'request',
        choice: 'deny',
      }),
    ).toBe('not_pending')
  },
)
test.each([
  ['ECONNREFUSED', false],
  ['ENOTFOUND', false],
  ['EAI_AGAIN', false],
  ['ERR_TLS_CERT_ALTNAME_INVALID', false],
  ['CERT_HAS_EXPIRED', false],
  ['ECONNRESET', true],
  ['ETIMEDOUT', true],
] as const)('transport %s preserves delivery uncertainty %s', async (code, maybeApplied) => {
  const client = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async () => {
      throw new TypeError('private transport details', { cause: { code } })
    },
  })
  await expect(
    client.submitApproval('builder', { runId: 'run', requestId: 'request', choice: 'once' }),
  ).rejects.toMatchObject({ code: 'transport_error', maybeApplied })
})
test('approval rejects a stale run credential generation without sending', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  await expect(
    client.submitApproval('builder', { runId: 'run', requestId: 'request', choice: 'once' }, 2),
  ).rejects.toMatchObject({ profile: 'builder' })
  expect(fetch).not.toHaveBeenCalled()
})

test('gate #7 gateway JSON validates identifiers before content redaction', async () => {
  const client = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async () =>
      Response.json({
        run_id: 'run_id',
        status: 'running',
        created_at: 1791374400,
        updated_at: 1791374400,
        session_id: 'sk-identifier12345678',
        output: 'apiKey=opaque-value',
      }),
  })
  expect(await client.getRun('builder', 'run_id')).toMatchObject({
    session_id: 'sk-identifier12345678',
    output: 'apiKey=[redacted]',
  })
  const invalid = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async () =>
      Response.json({
        run_id: 'run_id',
        status: 'running',
        created_at: 1791374400,
        updated_at: 1791374400,
        session_id: 'has space',
      }),
  })
  await expect(invalid.getRun('builder', 'run_id')).rejects.toMatchObject({
    code: 'invalid_response',
  })
})

test('a projection that fails transiently is thrown (retryable); a missing one falls back to the older body', async () => {
  const failing = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/approval')
      ? new Response(JSON.stringify({ resolved: 1 }), { status: 200 })
      : new Response('{}', { status: 503 }),
  )
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch: failing })
  await expect(
    client.submitApproval('builder', { runId: 'run-c', requestId: 'r', choice: 'once' }, 1),
  ).rejects.toMatchObject({ status: 503 })
  expect(failing.mock.calls.some(([input]) => String(input).endsWith('/approval'))).toBe(false)
  const missing = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/approval')
      ? new Response(JSON.stringify({ resolved: 1 }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 'run_not_found' } }), { status: 404 }),
  )
  const older = new GatewayClient({ scoreHome: env.home, db: env.db, fetch: missing })
  expect(
    await older.submitApproval('builder', { runId: 'run-d', requestId: 'r', choice: 'once' }, 1),
  ).toBe('applied')
  expect(JSON.parse(String(missing.mock.calls[1]?.[1]?.body))).toEqual({
    choice: 'once',
    request_id: 'r',
  })
})

test('an authority approval_not_pending refusal is not_pending', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/approval')
      ? new Response(JSON.stringify({ error: { code: 'approval_not_pending' } }), { status: 409 })
      : new Response(JSON.stringify({ execution_generation: 4 }), { status: 200 }),
  )
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  expect(
    await client.submitApproval('builder', { runId: 'run-e', requestId: 'p', choice: 'deny' }, 1),
  ).toBe('not_pending')
})

test('a clarify answer is exactly {request_id, execution_generation, answer}; Hermes no longer waiting is not_pending (decision 128)', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
    String(input).endsWith('/clarify')
      ? new Response(JSON.stringify({ status: 'resolved', prompt_id: 'clarify-1' }), {
          status: 200,
        })
      : new Response(JSON.stringify({ status: 'started', execution_generation: 4 }), {
          status: 200,
        }),
  )
  const client = new GatewayClient({ scoreHome: env.home, db: env.db, fetch })
  const request = { runId: 'run-q', promptId: 'clarify-1', generation: 2, answer: 'main' }
  expect(await client.submitClarify('builder', request, 1)).toBe('applied')
  // The question's own generation is used as asked; no projection read.
  expect(fetch.mock.calls).toHaveLength(1)
  expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8642/p/builder/v1/runs/run-q/clarify')
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    request_id: 'clarify-1',
    execution_generation: 2,
    answer: 'main',
  })
  // Without a recorded generation the run's current one is read first.
  expect(await client.submitClarify('builder', { ...request, generation: null }, 1)).toBe('applied')
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
    execution_generation: 4,
  })

  const gone = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ error: { code: 'stale_generation' } }), { status: 409 }),
  )
  const refused = new GatewayClient({ scoreHome: env.home, db: env.db, fetch: gone })
  expect(await refused.submitClarify('builder', request, 1)).toBe('not_pending')
})

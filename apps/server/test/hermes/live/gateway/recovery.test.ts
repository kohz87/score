import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '../../../../src/db/index.ts'
import { createIngest } from '../../../../src/hub/ingest.ts'
import { GatewayClient } from '../../../../src/hermes/live/gateway.ts'
import { RunIntents } from '../../../../src/hermes/live/intents.ts'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { followRun } from '../../../../src/hermes/live/runs.ts'
import { readRun, translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
async function context() {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    'recovery-turn',
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}
async function follow(runContext: Awaited<ReturnType<typeof context>>) {
  await followRun({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    context: runContext,
    metrics: { unknownEvents: 0 },
    backoff: { maxAttempts: 2, sleep: async () => {} },
    pollIntervalMs: 0,
  })
}

test('crash after gateway admission replays a sent intent with no second creation', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'recovery-turn'),
  ).rejects.toMatchObject({ code: 'transport_error' })
  expect(env.fake.creations).toBe(1)
  expect(env.db.sqlite.prepare('SELECT state, attempts FROM command_intents').get()).toEqual({
    state: 'unknown',
    attempts: 1,
  })
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'sent'").run()
  await env.ingest.close()
  env.db.close()
  env.db = openDatabase(join(env.home, 'score.db'))
  env.ingest = createIngest(env.db)
  env.gateway = new GatewayClient({ scoreHome: env.home, db: env.db, fetch: env.fake.fetch })
  env.intents = new RunIntents({ db: env.db, gateway: env.gateway, sink: env.ingest })
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  expect(
    env.db.sqlite.prepare('SELECT state, result, attempts FROM command_intents').get(),
  ).toEqual({ state: 'accepted', result: 'run_builder_1', attempts: 2 })
  expect(readRun(env.db.sqlite, 'run_builder_1')).toMatchObject({
    score_turn_id: 'recovery-turn',
    credential_generation: 1,
  })
  expect(
    await env.gateway.startRun({ profile: 'builder', input: 'fixture' }, 'recovery-turn'),
  ).toEqual({ runId: 'run_builder_1', replayed: true })
  await follow({ profile: 'builder', runId: 'run_builder_1', credentialGeneration: 1 })
  expect(readRun(env.db.sqlite, 'run_builder_1').status).toBe('completed')
})

test('accepted intent with no projection is attached after a crash without resending', async () => {
  const runContext = await context()
  env.db.sqlite.prepare('DELETE FROM runs').run()
  env.db.sqlite.prepare("DELETE FROM ingest_keys WHERE source = 'score-dispatch'").run()
  const before = env.fake.calls.length
  await env.intents.recoverIntents()
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('queued')
  expect(env.fake.calls).toHaveLength(before)
})

test('mid-stream disconnect resumes last seq with no duplicate tools or log drafts', async () => {
  env.fake.dropAt = 26
  const runContext = await context()
  await follow(runContext)
  expect(env.fake.streams).toBe(2)
  expect(
    env.fake.calls.filter((call) => call.path.endsWith('/events')).map((call) => call.cursor),
  ).toEqual([null, '25'])
  expect(readRun(env.db.sqlite, runContext.runId)).toMatchObject({
    status: 'completed',
    last_seq: 67,
  })
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM tool_calls').get()?.n).toBe(3)
  expect(
    env.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'log.line'").get()?.n,
  ).toBe(7)
  expect(env.db.sqlite.prepare('SELECT * FROM gaps').all()).toEqual([])
})

test('process restart resumes the persisted sequence', async () => {
  const runContext = await context()
  for (const event of env.fake.events.slice(0, 26))
    await env.ingest.submit(
      translateRunEvent(runContext, { ...event, run_id: runContext.runId }, { unknownEvents: 0 }),
    )
  await follow(runContext)
  expect(env.fake.calls.find((call) => call.path.endsWith('/events'))?.cursor).toBe('25')
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM tool_calls').get()?.n).toBe(3)
})

test.each(['404', 'truncation', 'give-up', 'EOF'] as const)(
  '%s records a gap and reconciles terminal status by polling',
  async (mode) => {
    env.fake.sse404 = mode === '404'
    env.fake.truncate = mode === 'truncation'
    env.fake.empty = mode === 'give-up'
    env.fake.eof = mode === 'EOF'
    const runContext = await context()
    await follow(runContext)
    expect(readRun(env.db.sqlite, runContext.runId).status).toBe('completed')
    const gaps = env.db.sqlite.prepare('SELECT * FROM gaps').all()
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ source: 'run-sse:builder', run_id: runContext.runId })
    expect(
      env.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'gap.recorded'").get()
        ?.n,
    ).toBe(1)
    expect(env.fake.polls).toBeGreaterThanOrEqual(2)
    expect(
      env.db.sqlite
        .prepare("SELECT identity FROM ingest_keys WHERE identity LIKE 'run_status:%@completed'")
        .get()?.identity,
    ).toBe(`run_status:${runContext.runId}@completed`)
  },
)

test('polling is bounded when the run remains unavailable', async () => {
  env.fake.sse404 = true
  env.fake.terminalAfterPoll = Infinity
  let clock = Date.now()
  const runContext = await context()
  await expect(
    followRun({
      db: env.db,
      gateway: env.gateway,
      sink: env.ingest,
      context: runContext,
      metrics: { unknownEvents: 0 },
      pollLimitMs: 4000,
      now: () => clock,
      wait: async (ms) => {
        clock += ms
      },
    }),
  ).rejects.toThrow('polling timed out')
  expect(env.fake.polls).toBe(3)
  expect(env.db.sqlite.prepare('SELECT * FROM gaps').all()).toHaveLength(1)
})

test('abort interrupts SSE backoff and polling without terminalizing the run', async () => {
  env.fake.sse404 = true
  env.fake.terminalAfterPoll = Infinity
  const controller = new AbortController()
  const runContext = await context()
  await followRun({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    context: runContext,
    metrics: { unknownEvents: 0 },
    signal: controller.signal,
    wait: async () => {
      controller.abort()
    },
  })
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('running')
  expect(env.fake.polls).toBe(2)
})

test('fast terminal status still replays retained tools before sealing the run', async () => {
  const runContext = await context()
  env.fake.runs.get(`builder:${runContext.runId}`)!.terminal = true
  await follow(runContext)
  expect(env.fake.streams).toBe(1)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM tool_calls').get()?.n).toBe(3)
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('completed')
})

test('concurrent admissions share one run, conflicting inputs are refused', async () => {
  const request = { profile: 'builder', input: 'one' }
  const first = env.intents.startRunIntent(request, 'concurrent-turn')
  const second = env.intents.startRunIntent(request, 'concurrent-turn')
  await expect(
    env.intents.startRunIntent({ ...request, input: 'two' }, 'concurrent-turn'),
  ).rejects.toThrow('different request')
  expect(await second).toEqual(await first)
  expect(env.fake.creations).toBe(1)
})

test('pending intent is sent at startup and definite rejection is marked failed', async () => {
  await context()
  env.db.sqlite.prepare("UPDATE command_intents SET state = 'pending'").run()
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  env.fake.keys.set('builder', 'different-fixture-key')
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'new' }, 'rejected-turn'),
  ).rejects.toMatchObject({ status: 401 })
  expect(
    env.db.sqlite
      .prepare('SELECT state FROM command_intents WHERE idempotency_key = ?')
      .get('rejected-turn')?.state,
  ).toBe('failed')
  const before = env.fake.calls.length
  await env.intents.recoverIntents()
  expect(env.fake.calls).toHaveLength(before)
})

test('a queued dispatch advances through status polling while SSE is quiet', async () => {
  const runContext = await context()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let polls = 0
  const client = new GatewayClient({
    scoreHome: env.home,
    db: env.db,
    fetch: async (url, init) => {
      if (String(url).endsWith('/events'))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      const response = await env.fake.fetch(url, init)
      if (String(url).endsWith(runContext.runId)) {
        const body: unknown = await response.json()
        const fields = body as Record<string, unknown>
        return Response.json({ ...fields, status: ++polls === 1 ? 'queued' : 'running' })
      }
      return response
    },
  })
  const pending = followRun({
    db: env.db,
    gateway: client,
    sink: env.ingest,
    context: runContext,
    metrics: { unknownEvents: 0 },
    pollIntervalMs: 0,
  })
  await expect.poll(() => readRun(env.db.sqlite, runContext.runId).status).toBe('running')
  expect(polls).toBe(2)
  stream!.enqueue(
    new TextEncoder().encode(
      `id: 0\ndata: ${JSON.stringify({ event: 'run.completed', run_id: runContext.runId, seq: 0, timestamp: 1791290587 })}\n\n: stream closed\n\n`,
    ),
  )
  stream!.close()
  await pending
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('completed')
})

import { readFileSync, rmSync } from 'node:fs'
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

test.each(['404', 'give-up', 'EOF'] as const)(
  '%s records a gap and reconciles terminal status by polling',
  async (mode) => {
    env.fake.sse404 = mode === '404'
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

test('a truncated replay records a gap and still delivers the retained events, including an approval', async () => {
  env.fake.truncate = true
  const runContext = await context()
  await follow(runContext)
  expect(readRun(env.db.sqlite, runContext.runId).status).toBe('completed')
  expect(env.db.sqlite.prepare('SELECT reason FROM gaps').all()).toEqual([
    { reason: 'SSE replay truncated (oldest retained 10)' },
  ])
  // Events from the retained part reached the projection: the stream was not abandoned for polling.
  expect(env.fake.polls).toBeLessThanOrEqual(1)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM tool_calls').get()?.n).toBeGreaterThan(0)
  const approval = env.fake.events.find((event) => event.event === 'approval.request')
  expect(approval && approval.seq >= 10).toBe(true)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM approvals').get()?.n).toBe(1)
})

test('status polling surfaces a pending approval the stream never delivered', async () => {
  env.fake.empty = true
  env.fake.terminalAfterPoll = 3
  env.fake.statusApproval = {
    ...env.fake.events.find((event) => event.event === 'approval.request')!,
    timestamp: Date.now() / 1000,
  }
  delete env.fake.statusApproval.seq
  const runContext = await context()
  await follow(runContext)
  expect(
    env.db.sqlite
      .prepare("SELECT count(*) AS n FROM approvals WHERE origin = 'score-run' AND run_id = ?")
      .get(runContext.runId)?.n,
  ).toBe(1)
})

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

test('a run Hermes no longer knows ends as interrupted instead of polling forever', async () => {
  const runContext = await context()
  env.fake.runs.delete(`builder:${runContext.runId}`)
  await follow(runContext)
  expect(readRun(env.db.sqlite, runContext.runId)).toMatchObject({
    status: 'interrupted',
    error: 'Hermes no longer has a record of this run',
  })
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

test.each(['sent', 'unknown'] as const)(
  'gate #4 %s admission beyond replay window never resubmits after Hermes drops its record',
  async (state) => {
    env.fake.crashAfterAdmission = true
    await expect(
      env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'old-turn'),
    ).rejects.toThrow()
    const firstSent = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    env.db.sqlite
      .prepare('UPDATE command_intents SET state = ?, first_sent_at = ?')
      .run(state, firstSent)
    env.fake.admissions.clear()
    const before = env.fake.calls.length
    await env.intents.recoverIntents()
    await env.intents.recoverIntents()
    expect(env.fake.calls).toHaveLength(before)
    expect(env.fake.creations).toBe(1)
    expect(
      env.db.sqlite
        .prepare('SELECT state, last_error, attempts, first_sent_at FROM command_intents')
        .get(),
    ).toEqual({
      state: 'unknown',
      last_error: 'replay_window_passed',
      attempts: 1,
      first_sent_at: firstSent,
    })
  },
)

test('gate #4 uncertain admission inside 23 hours replays and preserves first-send time', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'young-turn'),
  ).rejects.toThrow()
  const firstSent = new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString()
  env.db.sqlite.prepare('UPDATE command_intents SET first_sent_at = ?').run(firstSent)
  await env.intents.recoverIntents()
  expect(env.fake.creations).toBe(1)
  expect(env.db.sqlite.prepare('SELECT state, first_sent_at FROM command_intents').get()).toEqual({
    state: 'accepted',
    first_sent_at: firstSent,
  })
})

test('gate #1 gateway run SSE redacts assignments, headers and temporary AWS keys before durable storage', async () => {
  const text =
    'apiKey=opaque-one AWS_SECRET_ACCESS_KEY=opaque-two "clientSecret": "opaque-three" Authorization: Basic b3BhcXVl Authorization: Bearer opaque-four ASIA1234567890ABCDEF AKIA1234567890ABCDEF'
  const runContext = await context()
  const timestamp = 1791374400
  env.fake.events = [
    {
      run_id: runContext.runId,
      event: 'tool.started',
      seq: 1,
      timestamp,
      tool: 'terminal',
      preview: text,
    },
    {
      run_id: runContext.runId,
      event: 'tool.completed',
      seq: 2,
      timestamp,
      tool: 'terminal',
      preview: text,
      error: false,
      duration: 1,
    },
    { run_id: runContext.runId, event: 'run.completed', seq: 3, timestamp, output: text },
  ]
  await follow(runContext)
  const durable = Buffer.concat(
    ['score.db', 'score.db-wal'].map((file) => readFileSync(join(env.home, file))),
  ).toString()
  expect(durable).not.toMatch(
    /opaque-one|opaque-two|opaque-three|opaque-four|b3BhcXVl|ASIA1234567890ABCDEF|AKIA1234567890ABCDEF/,
  )
  expect(readRun(env.db.sqlite, runContext.runId).output).toContain('[redacted]')
})

// audit5-e: a reply cancelled while Hermes admitted its run must be stopped, however many tries that takes.
function cancelTurn(turnId: string) {
  env.db.sqlite.exec('PRAGMA foreign_keys = OFF')
  env.db.sqlite
    .prepare(
      `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES ('m1', NULL, 'room', 'builder', 'm0', 0, ?, 'm0', 'hi', '[]', 'failed', '2026-10-09T10:00:00.000Z')`,
    )
    .run(turnId)
}
const stops = () => env.fake.calls.filter((call) => call.path.endsWith('/stop')).length

test('a stop for a cancelled reply that failed is retried by recovery and by an explicit retry, until it succeeds', async () => {
  cancelTurn('cancel-turn')
  env.fake.stopFails = 1
  const request = { profile: 'builder', input: 'fixture' }
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(1)
  // Restart recovery: the accepted intent has its run row, but the stop is still owed.
  env.fake.stopFails = 1
  await env.intents.recoverIntents()
  expect(stops()).toBe(2)
  // An explicit admission retry (the ingest key is already used) still notices the cancellation.
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(3)
  // Confirmed: nothing more is sent.
  await env.intents.recoverIntents()
  await env.intents.startRunIntent(request, 'cancel-turn')
  expect(stops()).toBe(3)
})

test('FV #1: a frozen home delivers no owed Stop and resends no start from recovery; unfrozen, it does', async () => {
  cancelTurn('cancel-frozen')
  env.fake.stopFails = 1
  const request = { profile: 'builder', input: 'fixture' }
  await env.intents.startRunIntent(request, 'cancel-frozen')
  expect(stops()).toBe(1)
  // An accepted start_run intent whose Stop is still owed (the probe of re-review 4, finding 3).
  expect(env.db.sqlite.prepare('SELECT state, stop_state FROM command_intents').get()).toEqual({
    state: 'accepted',
    stop_state: 'pending',
  })
  // And a start that never got an answer.
  env.db.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       SELECT 'ci-open', kind, 'open-turn', payload, 'sent', created_at, updated_at FROM command_intents LIMIT 1`,
    )
    .run()
  const calls = env.fake.calls.length
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  const frozen = new RunIntents({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    frozen: () => holding,
  })
  await frozen.recoverIntents()
  expect(stops()).toBe(1)
  expect(env.fake.calls.length).toBe(calls)
  holding = null
  await frozen.recoverIntents()
  expect(stops()).toBe(2)
})

test('FU #3: a frozen home sends no start and no cancellation Stop through normal dispatch either; refusals are 423', async () => {
  let holding: string | null = 'Score is holding all agent work: this folder is a copy.'
  const frozen = new RunIntents({
    db: env.db,
    gateway: env.gateway,
    sink: env.ingest,
    frozen: () => holding,
  })
  const request = { profile: 'builder', input: 'fixture' }
  // The probe of re-review 5: a fresh dispatch reached the gateway. Now it is refused and no intent is recorded.
  await expect(frozen.startRunIntent(request, 'fresh-turn')).rejects.toMatchObject({
    status: 423,
    code: 'execution_frozen',
  })
  expect(env.fake.creations).toBe(0)
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM command_intents').get()).toEqual({ n: 0 })
  // An inherited cancelled reply whose start was accepted by the source: the owed Stop is not delivered.
  cancelTurn('inherited')
  env.fake.stopFails = 1
  await env.intents.startRunIntent(request, 'inherited')
  expect(stops()).toBe(1)
  await frozen.startRunIntent(request, 'inherited')
  expect(stops()).toBe(1)
  // An unfinished intent replayed through the normal path is refused too.
  env.db.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       SELECT 'ci-open', kind, 'open-turn', payload, 'sent', created_at, updated_at FROM command_intents LIMIT 1`,
    )
    .run()
  const creations = env.fake.creations
  await expect(frozen.startRunIntent(request, 'open-turn')).rejects.toMatchObject({ status: 423 })
  expect(env.fake.creations).toBe(creations)
  holding = null
  await frozen.startRunIntent(request, 'fresh-turn')
  expect(env.fake.creations).toBe(creations + 1)
})

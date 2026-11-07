import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GatewayClient } from '../../../../src/hermes/live/gateway.ts'
import { expect, test } from 'vitest'
import { followRun } from '../../../../src/hermes/live/runs.ts'
import { readRun, translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { context, env, follow, installRecoveryHooks } from './recovery-helpers.ts'

installRecoveryHooks()

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

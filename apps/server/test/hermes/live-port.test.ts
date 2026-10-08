import { SystemStatusSchema } from '@score/contract'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'
import { LivePort, type LivePortOptions } from '../../src/hermes/live/live-port.ts'
import { readRun, translateRunEvent } from '../../src/hermes/live/translate.ts'
import { buildFixture, insertTask } from '../fixtures/hermes/sqlite-fixture.ts'
import { setup } from './live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let port: LivePort | undefined
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await port?.stop()
  port = undefined
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})
function create(runner?: LivePortOptions['runner']) {
  const hermesHome = join(env.home, 'upstream-fixture')
  mkdirSync(hermesHome)
  writeFileSync(
    join(hermesHome, 'gateway_state.json'),
    JSON.stringify({ served_profiles: ['default', 'builder', 'reviewer'] }),
  )
  return (port = new LivePort({
    scoreHome: env.home,
    hermesHome,
    ...(runner ? { runner } : {}),
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    following: { backoff: { maxAttempts: 2, sleep: async () => {} }, pollIntervalMs: 0 },
  }))
}

test('adapter factory configures live mode and unstarted controls fail without accessing real Hermes', async () => {
  const live = createHermesPort(
    loadConfig({
      SCORE_MODE: 'live',
      SCORE_HOME: env.home,
      SCORE_HERMES_HOME: join(env.home, 'missing-fixture'),
    }),
  )
  expect(live.mode).toBe('live')
  expect(SystemStatusSchema.parse({ mode: live.mode, ...live.status() })).toMatchObject({
    hermes: { reachable: false, apiServer: false },
  })
  await expect(
    live.startRun({ agentId: 'builder', input: 'hello', turnId: 'turn' }),
  ).rejects.toMatchObject({ status: 503, code: 'hermes_unavailable' })
  await live.stop()
})

test('health and capabilities are cached; profile readers include agents without keys', async () => {
  const live = create()
  await live.start(env.ingest)
  expect(SystemStatusSchema.parse({ mode: 'live', ...live.status() })).toMatchObject({
    hermes: {
      version: '0.21.5',
      reachable: true,
      servedProfiles: ['default', 'builder', 'reviewer'],
      capabilities: expect.arrayContaining(['run_submission']),
    },
    degraded: expect.arrayContaining([
      'reviewer: credentials unavailable',
      'Untested Hermes build: unknown (unknown)',
    ]),
  })
  const before = env.fake.calls.length
  for (let i = 0; i < 10; i++) live.status()
  const agents = await live.listAgents()
  expect(env.fake.calls).toHaveLength(before)
  expect(agents).toMatchObject([
    { id: 'builder', served: true, style: { color: '#6B4EFF', shape: 'circle-dot' } },
    { id: 'default', served: true, style: { color: '#19C39A', shape: 'triangle' } },
    { id: 'reviewer', served: true, style: { color: '#FFB61E', shape: 'diamond' } },
  ])
  await expect(
    live.deliverDecision({
      approvalId: 'missing',
      choice: 'once',
      origin: 'score-run',
      profile: 'builder',
      runId: null,
      requestId: 'missing',
    }),
  ).rejects.toMatchObject({ code: 'invalid_target', maybeApplied: false })
})

test('starts idempotently, follows to completion and forwards stop', async () => {
  const live = create()
  await live.start(env.ingest)
  const results = await Promise.all([
    live.startRun({
      agentId: 'builder',
      input: 'hello',
      turnId: 'live-turn',
      model: 'fixture-model',
    }),
    live.startRun({
      agentId: 'builder',
      input: 'hello',
      turnId: 'live-turn',
      model: 'fixture-model',
    }),
  ])
  expect(results[0]).toEqual(results[1])
  expect(env.fake.creations).toBe(1)
  await expect.poll(() => readRun(env.db.sqlite, results[0]!.runId).status).toBe('completed')
  await live.stopRun({ agentId: 'builder', runId: results[0]!.runId })
  expect(env.fake.calls.some((call) => call.path.endsWith('/stop'))).toBe(true)
  await expect(
    live.startRun({ agentId: 'unserved', input: 'hello', turnId: 'unserved-turn' }),
  ).rejects.toMatchObject({ status: 503 })
})

test('startup recovers an uncertain admission and follows its original run', async () => {
  env.fake.crashAfterAdmission = true
  await expect(
    env.intents.startRunIntent({ profile: 'builder', input: 'hello' }, 'startup-turn'),
  ).rejects.toThrow()
  const live = create()
  await live.start(env.ingest)
  await expect.poll(() => readRun(env.db.sqlite, 'run_builder_1').status).toBe('completed')
  expect(env.fake.creations).toBe(1)
})

test('startup re-follows existing nonterminal Score runs from persisted seq', async () => {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'hello' },
    'restart-turn',
  )
  const context = { profile: 'builder', runId, credentialGeneration: 1 }
  for (const event of env.fake.events.slice(0, 26))
    await env.ingest.submit(
      translateRunEvent(context, { ...event, run_id: runId }, { unknownEvents: 0 }),
    )
  const live = create()
  await live.start(env.ingest)
  await expect.poll(() => readRun(env.db.sqlite, runId).status).toBe('completed')
  expect(env.fake.calls.find((call) => call.path.endsWith('/events'))?.cursor).toBe('25')
})

test('an unreachable gateway starts in degraded mode and stops cleanly', async () => {
  port = new LivePort({
    scoreHome: env.home,
    hermesHome: join(env.home, 'missing-fixture'),
    db: env.db,
    fetch: async () => {
      throw new Error('fixture offline')
    },
    readCliVersion: async () => null,
  })
  await port.start(env.ingest)
  expect(port.status()).toMatchObject({
    hermes: { reachable: false, servedProfiles: [] },
    degraded: expect.arrayContaining([
      'Served profiles unavailable',
      'Gateway unreachable',
      'Untested Hermes build: unknown (unknown)',
    ]),
  })
})

test('the live port uses the shared Score DB and refuses to start without it', async () => {
  const hermesHome = join(env.home, 'upstream-fixture')
  mkdirSync(hermesHome)
  writeFileSync(
    join(hermesHome, 'gateway_state.json'),
    JSON.stringify({ served_profiles: ['builder'] }),
  )
  const orphan = new LivePort({ scoreHome: env.home, hermesHome, fetch: env.fake.fetch })
  await expect(orphan.start(env.ingest)).rejects.toThrow('shared Score DB')
  port = new LivePort({
    scoreHome: env.home,
    hermesHome,
    fetch: env.fake.fetch,
    db: env.db,
    readCliVersion: async () => null,
  })
  await port.start(env.ingest)
  const result = await port.startRun({ agentId: 'builder', input: 'hello', turnId: 'shared-turn' })
  await expect.poll(() => readRun(env.db.sqlite, result.runId).status).toBe('completed')
  await port.stop()
  // Stopping the port must not close the server's shared connection.
  expect(env.db.sqlite.prepare('SELECT count(*) AS n FROM runs').get()?.n).toBe(1)
})

test('stop drains a pending admission before releasing its DB connection', async () => {
  const live = create()
  await live.start(env.ingest)
  const pending = live.startRun({ agentId: 'builder', input: 'hello', turnId: 'shutdown-turn' })
  await live.stop()
  expect(await pending).toEqual({ runId: 'run_builder_1' })
  expect(readRun(env.db.sqlite, 'run_builder_1').status).toBe('queued')
  expect(env.db.sqlite.prepare('SELECT state FROM command_intents').get()?.state).toBe('accepted')
})

test.each([
  [200, { resolved: 1 }, 'applied'],
  [409, { error: 'approval_not_active' }, 'not_pending'],
  [200, { resolved: 0 }, 'uncertain'],
  [500, { error: 'private message' }, 'retry'],
  [429, { error: 'private message' }, 'retry'],
  [400, { error: 'private message' }, 'failed'],
] as const)('live approval delivery classifies %i %j', async (status, body, expected) => {
  const fetch: typeof globalThis.fetch = async (url, init) =>
    String(url).endsWith('/approval')
      ? new Response(JSON.stringify(body), { status })
      : env.fake.fetch(url, init)
  port = new LivePort({
    scoreHome: env.home,
    db: env.db,
    hermesHome: join(env.home, 'missing'),
    fetch,
    readCliVersion: async () => null,
  })
  await port.start(env.ingest)
  env.gateway.generation('builder')
  env.db.sqlite
    .prepare(
      `INSERT INTO runs (id, profile, origin, credential_generation, status, started_at, updated_at) VALUES ('approval-run', 'builder', 'score', 1, 'running', ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString())
  const delivery = port.deliverDecision({
    approvalId: 'approval',
    origin: 'score-run',
    profile: 'builder',
    runId: 'approval-run',
    requestId: 'exact-request',
    choice: 'once',
  })
  if (expected === 'applied' || expected === 'not_pending') expect(await delivery).toBe(expected)
  else
    await expect(delivery).rejects.toMatchObject({
      maybeApplied: expected !== 'failed',
      retryable: expected === 'retry',
    })
})

test.each(['builder', 'reviewer'])(
  'live task actions redact only a known exact %s gateway key',
  async (assignee) => {
    const runner = vi.fn<NonNullable<LivePortOptions['runner']>>(async () => ({ exitCode: 0 }))
    const live = create(runner)
    const fixture = buildFixture(join(env.home, 'upstream-fixture', 'kanban.db'), 'kanban')
    try {
      insertTask(fixture, 't_test')
      fixture.prepare("UPDATE tasks SET status = 'blocked', assignee = ?").run(assignee)
      await live.start(env.ingest)
      const key = env.fake.keys.get('builder')!
      const text =
        assignee === 'builder' ? `Deny ${key}; password=example` : 'Deny; password=example'
      expect(await live.taskAction({ taskId: 't_test', action: 'comment', text })).toEqual({
        hermesStatus: 'blocked',
      })
      expect(runner).toHaveBeenCalledWith(
        [
          'kanban',
          'comment',
          '--author',
          'score',
          '--',
          't_test',
          assignee === 'builder' ? 'Deny [redacted]; password=example' : text,
        ],
        { timeoutMs: 10000, hermesHome: join(env.home, 'upstream-fixture') },
      )
    } finally {
      fixture.close()
    }
  },
)

test.each(['polling', 'error'] as const)(
  'gate #11 supervisor restarts a follower after %s stops and backs off until terminal',
  async (mode) => {
    const run = await env.intents.startRunIntent(
      { profile: 'builder', input: 'fixture' },
      'supervised-run',
    )
    env.fake.terminalAfterPoll = Infinity
    env.fake.sse404 = mode === 'polling'
    const events = env.fake.events
    if (mode === 'error') env.fake.events = [{ ...events[0]!, seq: -1 }]
    const waits: number[] = []
    let now = Date.now()
    const errors: unknown[] = []
    port = new LivePort({
      scoreHome: env.home,
      hermesHome: join(env.home, 'missing-fixture'),
      db: env.db,
      fetch: env.fake.fetch,
      readCliVersion: async () => null,
      onError: (error) => errors.push(error),
      following: {
        backoff: { maxAttempts: 1, sleep: async () => {} },
        pollLimitMs: 1,
        pollIntervalMs: 1,
        now: () => now,
        wait: async (ms) => {
          now += ms
          if (ms >= 60_000) {
            waits.push(ms)
            if (waits.length === 4) {
              env.fake.terminalAfterPoll = 0
              env.fake.sse404 = false
              env.fake.events = events
            }
          }
        },
      },
    })
    await port.start(env.ingest)
    await expect.poll(() => readRun(env.db.sqlite, run.runId).status).toBe('completed')
    expect(waits).toEqual([60_000, 300_000, 900_000, 900_000])
    expect(errors).toHaveLength(4)
    expect(env.fake.streams).toBe(5)
  },
)

test('gate #11 stopping the port interrupts supervisor backoff without restarting', async () => {
  await env.intents.startRunIntent({ profile: 'builder', input: 'fixture' }, 'stopped-supervisor')
  env.fake.sse404 = true
  env.fake.terminalAfterPoll = Infinity
  const error = vi.fn()
  port = new LivePort({
    scoreHome: env.home,
    hermesHome: join(env.home, 'missing-fixture'),
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    onError: error,
    following: { pollLimitMs: 0 },
  })
  await port.start(env.ingest)
  await expect.poll(() => error.mock.calls.length).toBe(1)
  const calls = env.fake.calls.length
  await port.stop()
  expect(env.fake.calls).toHaveLength(calls)
})

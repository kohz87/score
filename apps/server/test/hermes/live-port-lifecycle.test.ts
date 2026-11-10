import { SystemStatusSchema } from '@score/contract'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createHermesPort } from '../../src/hermes/index.ts'
import { LivePort, type LivePortOptions } from '../../src/hermes/live/live-port.ts'
import { readRun, translateRunEvent } from '../../src/hermes/live/translate.ts'
import { createLivePort, installLivePortHooks, type LivePortEnv } from './live-port-helpers.ts'

let env: LivePortEnv
let port: LivePort | undefined

installLivePortHooks(
  (state) => {
    env = state.env
    port = state.port
  },
  () => ({ env, port }),
)

function create(runner?: LivePortOptions['runner'], frozen?: () => string | null) {
  return (port = createLivePort(env, runner, frozen))
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
    { id: 'builder', served: true, style: { color: '#6B4EFF', shape: 'ball' } },
    { id: 'default', served: true, style: { color: '#19C39A', shape: 'drop' } },
    { id: 'reviewer', served: true, style: { color: '#FFB61E', shape: 'triangle' } },
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

test('a permanent Hermes refusal becomes an HttpError, also when the failed intent is replayed', async () => {
  const live = create()
  await live.start(env.ingest)
  env.fake.keys.set('builder', 'different-fixture-key')
  const request = { agentId: 'builder', input: 'hello', turnId: 'refused-turn' }
  await expect(live.startRun(request)).rejects.toMatchObject({
    name: 'HttpError',
    status: 422,
  })
  await expect(live.startRun(request)).rejects.toMatchObject({
    name: 'HttpError',
    code: 'admission_refused',
  })
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
    firstStatusWaitMs: 0,
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
  const orphan = new LivePort({
    firstStatusWaitMs: 0,
    scoreHome: env.home,
    hermesHome,
    fetch: env.fake.fetch,
  })
  await expect(orphan.start(env.ingest)).rejects.toThrow('shared Score DB')
  port = new LivePort({
    firstStatusWaitMs: 0,
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

import { expect, test, vi } from 'vitest'
import { readRun } from '../../src/hermes/live/translate.ts'
import { createLivePort, installLivePortHooks, type LivePortEnv } from './live-port-helpers.ts'

let env: LivePortEnv
let port: ReturnType<typeof createLivePort> | undefined

installLivePortHooks(
  (state) => {
    env = state.env
    port = state.port
  },
  () => ({ env, port }),
)

function create() {
  return (port = createLivePort(env))
}

test('stopping a run Hermes no longer has ends it in Score as lost (3.7.1)', async () => {
  const live = create()
  await live.start(env.ingest)
  const started = await live.startRun({
    agentId: 'builder',
    input: 'hello',
    turnId: 'ghost-source',
    model: 'fixture-model',
  })
  await expect.poll(() => readRun(env.db.sqlite, started.runId).status).toBe('completed')
  // A run Score still thinks is running, which Hermes has never heard of (parked, then forgotten).
  env.db.sqlite.exec(
    `CREATE TEMP TABLE ghost AS SELECT * FROM runs WHERE id = '${started.runId}';
     UPDATE ghost SET id = 'run_ghost', status = 'running', ended_at = NULL, score_turn_id = 'ghost-turn';
     INSERT INTO runs SELECT * FROM ghost; DROP TABLE ghost;`,
  )
  await live.stopRun({ agentId: 'builder', runId: 'run_ghost' })
  // A stop of a forgotten run ends it as stopped, not as a failure (nothing retries it).
  await expect.poll(() => readRun(env.db.sqlite, 'run_ghost').status).toBe('cancelled')
})

test('a run Hermes accepted a stop for but never ended is ended in Score by a second Stop after the grace (3.7.2)', async () => {
  const live = create()
  await live.start(env.ingest)
  const started = await live.startRun({
    agentId: 'builder',
    input: 'hello',
    turnId: 'stuck-source',
    model: 'fixture-model',
  })
  await expect.poll(() => readRun(env.db.sqlite, started.runId).status).toBe('completed')
  // Hermes still has the run (stop answers 200), but it never reports an end: Score still sees it running.
  env.db.sqlite
    .prepare("UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?")
    .run(started.runId)
  await live.stopRun({ agentId: 'builder', runId: started.runId })
  expect(readRun(env.db.sqlite, started.runId).status).toBe('running')
  // A second Stop within the grace only asks again.
  await live.stopRun({ agentId: 'builder', runId: started.runId })
  expect(readRun(env.db.sqlite, started.runId).status).toBe('running')
  const later = Date.now() + 6000
  vi.spyOn(Date, 'now').mockReturnValue(later)
  try {
    await live.stopRun({ agentId: 'builder', runId: started.runId })
    await expect.poll(() => readRun(env.db.sqlite, started.runId).status).toBe('cancelled')
    expect(readRun(env.db.sqlite, started.runId).error).toMatch(/never ended/)
  } finally {
    vi.restoreAllMocks()
  }
})

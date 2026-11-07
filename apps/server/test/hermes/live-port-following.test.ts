import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { LivePort } from '../../src/hermes/live/live-port.ts'
import { readRun } from '../../src/hermes/live/translate.ts'
import { installLivePortHooks, type LivePortEnv } from './live-port-helpers.ts'

let env: LivePortEnv
let port: LivePort | undefined

installLivePortHooks(
  (state) => {
    env = state.env
    port = state.port
  },
  () => ({ env, port }),
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
      firstStatusWaitMs: 0,
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
    firstStatusWaitMs: 0,
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

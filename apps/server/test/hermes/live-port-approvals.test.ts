import { join } from 'node:path'
import { expect, test } from 'vitest'
import { LivePort } from '../../src/hermes/live/live-port.ts'
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
    firstStatusWaitMs: 0,
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

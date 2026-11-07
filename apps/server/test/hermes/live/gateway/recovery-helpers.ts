import { rmSync } from 'node:fs'
import { afterEach, beforeEach } from 'vitest'
import { followRun } from '../../../../src/hermes/live/runs.ts'
import { setup } from './helpers.ts'

export type RecoveryEnv = ReturnType<typeof setup>

export let env: RecoveryEnv

export function installRecoveryHooks() {
  beforeEach(() => {
    env = setup()
  })
  afterEach(async () => {
    await env.ingest.close()
    env.db.close()
    rmSync(env.home, { recursive: true, force: true })
  })
}

export async function context() {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    'recovery-turn',
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

export async function follow(runContext: Awaited<ReturnType<typeof context>>) {
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

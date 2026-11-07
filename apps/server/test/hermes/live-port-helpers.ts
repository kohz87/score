import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { LivePort, type LivePortOptions } from '../../src/hermes/live/live-port.ts'
import { setup } from './live/gateway/helpers.ts'

export type LivePortEnv = ReturnType<typeof setup>

export interface LivePortState {
  env: LivePortEnv
  port: LivePort | undefined
}

export function createLivePortState(): LivePortState {
  return { env: setup(), port: undefined }
}

export function installLivePortHooks(
  assign: (state: LivePortState) => void,
  current: () => LivePortState,
): void {
  beforeEach(() => assign(createLivePortState()))
  afterEach(async () => {
    const state = current()
    await state.port?.stop()
    await state.env.ingest.close()
    state.env.db.close()
    rmSync(state.env.home, { recursive: true, force: true })
  })
}

export function createLivePort(
  env: LivePortEnv,
  runner?: LivePortOptions['runner'],
  frozen?: () => string | null,
): LivePort {
  const hermesHome = join(env.home, 'upstream-fixture')
  mkdirSync(hermesHome)
  writeFileSync(
    join(hermesHome, 'gateway_state.json'),
    JSON.stringify({ served_profiles: ['default', 'builder', 'reviewer'] }),
  )
  return new LivePort({
    firstStatusWaitMs: 0,
    scoreHome: env.home,
    hermesHome,
    ...(runner ? { runner } : {}),
    ...(frozen ? { frozen } : {}),
    db: env.db,
    fetch: env.fake.fetch,
    readCliVersion: async () => null,
    following: { backoff: { maxAttempts: 2, sleep: async () => {} }, pollIntervalMs: 0 },
  })
}

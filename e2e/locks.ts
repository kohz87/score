import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'

// Specs run in parallel workers on ONE server, so some of its state is shared. A spec that changes such state, or reads
// something that depends on it, takes the matching lock around the part that matters (T3, 2026-10-18):
//  - 'model-lists': the chosen-models list (Settings, 5.31) is server-wide. While model-settings.spec.ts has it
//    narrowed, every picker lists only "Local server", so model-picker.spec.ts timed out waiting for its options.
//  - 'roster': the team. model-picker.spec.ts adds an agent for a moment; reports.spec.ts and team.spec.ts count agents.
// A directory is the lock (mkdir is atomic across processes); one left by a crashed worker is taken over after a
// minute. Always take 'roster' before 'model-lists'.
const STALE_MS = 60_000
export type LockName = 'model-lists' | 'roster'

/** Waits for the lock and returns the function that releases it. */
export async function acquireLock(name: LockName): Promise<() => void> {
  const dir = join(process.env.SCORE_E2E_HOME!, `${name}.lock`)
  const until = Date.now() + 120_000
  for (;;) {
    try {
      mkdirSync(dir)
      return () => rmSync(dir, { recursive: true, force: true })
    } catch {
      let age: number
      try {
        age = Date.now() - statSync(dir).mtimeMs
      } catch {
        continue // released between the two calls
      }
      if (age > STALE_MS) rmSync(dir, { recursive: true, force: true })
      else if (Date.now() > until) throw new Error(`Timed out waiting for the ${name} lock.`)
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

export async function withLock<T>(name: LockName, work: () => Promise<T>): Promise<T> {
  const release = await acquireLock(name)
  try {
    return await work()
  } finally {
    release()
  }
}

/** For a whole spec file that only reads the team: each test runs while no spec is adding an agent. */
export function holdLockPerTest(name: LockName): void {
  let release: (() => void) | undefined
  test.beforeEach(async () => {
    release = await acquireLock(name)
  })
  test.afterEach(() => {
    release?.()
    release = undefined
  })
}

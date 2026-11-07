import type { HermesCheck } from '@score/contract'
import type { HermesUpdateSpawner } from './cli.ts'

// 3.15.0 (owner, 2026-11-02): update Hermes from Settings › System. One job at a time, in memory (a Score restart
// forgets it; Hermes's own update keeps running and Score's version check still reports the result). The steps:
// wait until no Score run is active, `hermes update --backup --yes` (Hermes backs itself up, waits for its own
// in-flight turns, restarts its gateway), Score's compatibility check, one short test message to an agent the person
// picks. Score never reads Hermes's files for the backup and never rolls Hermes's code back itself.

export interface HermesUpdatesDeps {
  hermesHome?: string | undefined
  spawn: HermesUpdateSpawner
  clock?: () => number
  /** Score has no active turn or run; `note` says what is still going. */
  idle: () => { idle: boolean; note: string }
  /** `hermes --version`'s first line, e.g. "Hermes Agent v0.22.5+3257.g557254f (…)"; null when unknown. */
  version: () => Promise<string | null>
  check: () => Promise<HermesCheck>
  accept: (hash: string) => Promise<void>
  startTestRun: (agentId: string, input: string) => Promise<{ runId: string }>
  readRun: (
    runId: string,
  ) => { status: string; output: string | null; error: string | null } | undefined
  /** Stops the test run when it never ends (e.g. waiting for an approval). */
  stopTestRun?: (agentId: string, runId: string) => Promise<void>
  diskFreeBytes: () => Promise<number | null>
  backupNeedsBytes: () => Promise<number | null>
  /**
   * Where a running update is recorded, so a Score restart while Hermes is still updating refuses a second update
   * (review: the update runs detached and outlives Score).
   */
  marker?: {
    read(): { pid: number; startedAt: string } | null
    write(value: { pid: number; startedAt: string }): void
    clear(): void
    alive(pid: number): boolean
  }
  sleep?: (ms: number) => Promise<void>
  /** Limits, overridable in tests. */
  limits?: Partial<typeof LIMITS>
}

export const LIMITS = {
  waitMs: 30 * 60_000,
  waitPollMs: 5_000,
  updateMs: 45 * 60_000,
  checkTries: 9,
  checkPollMs: 10_000,
  testMs: 4 * 60_000,
  testPollMs: 3_000,
}
export const MAX_LOG = 200
export const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted']
export const TEST_MESSAGE =
  'Score is checking a Hermes update: reply with the single word PONG and nothing else.'

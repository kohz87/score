import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { OrchestrationOwner } from '../../domain/orchestration/owner.ts'
import type { Ingest } from '../../hub/ingest.ts'
import { redactBounded } from '../../redact.ts'
import type { RootPolicy } from '../../workspace/policy.ts'
import type { CliLocator } from './cli.ts'
import type { driverFor } from './drivers.ts'
import type { spawnCli, StopReason } from './process.ts'
import type { killRecordedGroup } from './proc.ts'
import type { TerminalInfo } from './translate.ts'
import type { UnitBackend } from './unit-backend.ts'

export interface CodingRuntimeDeps {
  db: ScoreDb
  ingest: Pick<Ingest, 'submit'>
  locator: CliLocator
  /** Score's home: per-agent settings files live under `<home>/coding/<agent>/`. */
  home: string
  /** The same folder rules as the Workspace tab (6.1). */
  policy: RootPolicy
  onError?: (error: unknown) => void
  maxTurnMs?: number
  graceMs?: number
  /** First wait before a failed terminal result is saved again (doubles each time). */
  terminalRetryMs?: number
  /** Test seam: the process launcher. */
  spawn?: typeof spawnCli
  /** Test seam: how a recorded group is stopped and proven gone. */
  killGroup?: typeof killRecordedGroup
  /** First wait before an unresolved group is stopped again in the background (doubles to a minute). */
  reapRetryMs?: number
  /** How long Stop waits to see a recorded group end before it answers `unconfirmed` (the kill goes on). */
  stopObserveMs?: number
  /**
   * The supervised-unit backend (7.7a). Present only where Score owns an installation journal; a run uses it while its
   * capability check passes, and the process-group backend otherwise.
   */
  unit?: UnitBackend
  /**
   * Records that a stop was asked, with its cause (`user`, `deadline`, `output-cap`, `score-shutdown`), before anything is
   * signalled. The unit backend wires it to the journal; absent where there is none. A failure is reported, never thrown.
   */
  onStop?: (cause: string) => void
  /**
   * Whether a recorded process row belongs to this installation (not an inherited copy). Asked before every signal to a
   * `coding_processes` row, in recovery and in the reaper; false = never signalled, never treated as ours. Default: true.
   */
  ownsProcessRow?: (runId: string) => boolean
  /**
   * Why Score holds all agent work (decision 71: an unresolved or copied home, a lost or truncated journal), as the
   * sentence the person reads, or null. While non-null nothing is admitted and recovery signals nothing.
   */
  frozen?: () => string | null
  /** Units carrying this installation's prefix that no journal launch owns: the caller fences and raises a review item. */
  onOrphans?: (units: string[]) => void
}

/** What both launch backends hand back to `execute()`. */
export interface Attempt {
  exitCode: number | null
  signal: string | null
  stopped: StopReason | null
  stderr: string
  spawnError: string | null
  leftovers: boolean
  /** Every process of the run is proven gone (a group for the fallback, the unit's cgroup for the unit backend). */
  groupGone: boolean
  /** Every stdout record was parsed and saved (completeness, design §4). */
  complete: boolean
  /** Set when the run never started (refused, revoked, stopped first). */
  refusal: string | null
  reasons: string[]
  launchId: string | null
  /** The typed cause when the launch ended before the CLI (unit backend only). */
  refusalCause: string | null
}

export interface ActiveRun {
  agentId: string
  runId: string
  turnId: string
  /** Set when an orchestration attempt generation owns the run (7.7b §5). */
  owner?: OrchestrationOwner
  /** The job its subagents count against, when the run has none of its own (an orchestration's). */
  jobId?: string
  /** Set once the process (or unit) exists. */
  process?: { stop(reason?: StopReason): void }
  /** Stop asked while the turn was still waiting for the agent's previous turn. */
  stopBeforeStart?: StopReason
  /** A process was started for this run: Stop must then wait for proof that its group ended. */
  launched?: boolean
  /** Some group of this run was not proven gone. */
  unproven?: boolean
  /** Settles when the run has ended: true when every group it started is proven gone. */
  ended: Promise<boolean>
  settle(): void
}

export const IntentRow = z.object({
  id: z.string(),
  state: z.enum(['pending', 'sent', 'accepted', 'failed', 'unknown']),
  result: z.string().nullable(),
  payload: z.string(),
})
export const IntentPayload = z.object({
  agentId: z.string(),
  input: z.string(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
})
export const ProcessRow = z.object({
  run_id: z.string(),
  pid: z.int(),
  pgid: z.int(),
  start_time: z.string().nullable(),
  boot_id: z.string().nullable(),
  unresolved: z.int(),
  unobservable: z.int(),
})
export const MemberRow = z.object({ pid: z.int(), start_time: z.string() })
export const KIND = 'start_coding_run'
export const UNRESOLVED_NOTE =
  'Some of its tools may still be running. Score keeps trying to stop them and will let this agent take new messages once they have ended.'

export const TERMINAL_NOTE = {
  interrupted:
    'Score restarted while this ran. The conversation is kept, so the next message resumes it.',
} as const

/** The CLI's own "that session doesn't exist" refusal, matched per driver (anchored, so ordinary errors don't count). */
export function refusesResume(driver: ReturnType<typeof driverFor>, message: string): boolean {
  return driver.resumeRefusal?.test(message.trim()) ?? false
}

/** The terminal info as it may be stored: every free-text field redacted and bounded, as `terminalObservation` stores it. */
export function redactedInfo(info: TerminalInfo): TerminalInfo {
  const { output, error, reply } = info
  return {
    ...info,
    ...(output == null ? {} : { output: redactBounded(output, 8192) }),
    ...(error == null ? {} : { error: redactBounded(error, 2048) }),
    ...(reply == null ? {} : { reply: redactBounded(reply, 8192) }),
  }
}

export function oneLine(text: string, max: number): string {
  return redactBounded(text.replace(/\s+/g, ' ').trim(), max)
}

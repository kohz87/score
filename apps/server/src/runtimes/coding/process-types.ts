import type { signalGroup, signalPid } from './pidfd-signal.ts'
import type { kernelGroupExists, MemberIdentity, ProcEnv } from './proc.ts'
import type { CodingEvent, LineParser } from './types.ts'

export type StopReason = 'user' | 'timeout' | 'output_limit' | 'shutdown'

export const STOP_CAUSE: Record<StopReason, string> = {
  user: 'user',
  timeout: 'deadline',
  output_limit: 'output-cap',
  shutdown: 'score-shutdown',
}
/** The cause string the stop-recording hook receives. */
export function stopCauseOf(reason: StopReason): string {
  return STOP_CAUSE[reason]
}

export interface CliOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stopped: StopReason | null
  /** The start of stderr, already redacted and bounded (a tail cut through a labelled value would leak it). */
  stderr: string
  /**
   * Whether the whole stdout stream was seen and handled: no partial last line, no read error and no dropped (oversized)
   * record. False disqualifies the result, as for the supervised unit.
   */
  streamComplete: boolean
  /** Why the stream is incomplete (empty when complete). */
  streamLoss: string[]
  /** The process could not be started at all. */
  spawnError: string | null
  /**
   * The CLI's own process ended, but tools it started were still running; they were given the grace period and then
   * stopped (S2-005).
   */
  leftovers: boolean
  /** The whole process group is empty. False only when something survived SIGKILL: the durable record must stay. */
  groupGone: boolean
  /** Whether the CLI printed any line we understood. */
  sawEvents: boolean
  stats: LineParser['stats']
}

/**
 * `onSpawn` threw. The group has been sent SIGKILL; `terminated` settles (true = the whole group is gone) so the
 * caller can wait for the proof before it reports anything.
 */
export class SpawnRecordError extends Error {
  constructor(
    readonly original: unknown,
    readonly terminated: Promise<boolean>,
  ) {
    super(original instanceof Error ? original.message : String(original), { cause: original })
  }
}

export interface CliRun {
  /** SIGINT, then SIGTERM, then SIGKILL, a few seconds apart. Safe to call more than once. */
  stop(reason?: StopReason): void
  readonly pid: number | undefined
  done: Promise<CliOutcome>
}

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin: string
  parser: LineParser
  /** Called in order, one at a time; a rejection is the caller's to handle (the run goes on). */
  onEvent(event: CodingEvent): Promise<void>
  /**
   * Called synchronously right after the spawn (records the process durably). Supervision is installed first; if this
   * throws, the whole group is killed and the error propagates (S2-004). The CLI is not executed, and gets no prompt,
   * until this has returned.
   */
  onSpawn?(pid: number): void
  /**
   * Called with the identities (pid + start time) of group members not reported before: while the leader runs, when it
   * exits with survivors, and while the group is reaped. They are the continuity that lets a leaderless group be
   * recognised as ours after a restart (N4). A throw never fails the run: the members are offered again on the next scan.
   */
  onMembers?(members: MemberIdentity[]): void
  /** A save failed; the same members are offered again on the next scan. Called once per streak of failures. */
  onMembersError?(error: unknown): void
  /**
   * Called once, synchronously, with the cause (`user`, `deadline`, `output-cap`, `score-shutdown`) before the group is
   * first signalled, on every stop path. It must not throw; if it does, `onStopError` hears of it and the stop goes on.
   */
  onStop?(cause: string): void
  onStopError?(error: unknown): void
  /** Test seam: the process table (default /proc). */
  procEnv?: ProcEnv
  /** Test seam: the kernel's answer to "does any process have this PGID" (default `kill(-pgid, 0)`). */
  groupExists?: typeof kernelGroupExists
  /** How often members are noted while the leader runs (default 100 ms: members found while the leader lives are the only proof of ownership once it has exited). */
  memberScanMs?: number
  maxMs?: number
  graceMs?: number
  /**
   * Test seams for how signals are sent (to fake a survivor that ignores them, or an unavailable/mismatching pidfd).
   * Defaults go through pidfds; there is no numeric kill anywhere in this module.
   */
  signalGroup?: typeof signalGroup
  signalPid?: typeof signalPid
  /** Test seam: how long past the second grace the reaper keeps trying before it gives up (default 10 s). */
  reapSlackMs?: number
}

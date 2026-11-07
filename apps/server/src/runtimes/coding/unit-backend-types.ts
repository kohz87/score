import type { ScoreDb } from '../../db/index.ts'
import type { CodingJournal, ReleaseDecision } from '../../domain/orchestration/coding-journal.ts'
import type { OwnedLaunchJournal, PreparedLaunch } from '../../domain/orchestration/owner.ts'
import type { CodingSocketServer } from './coding-socket.ts'
import type { PidSignalResult } from './pidfd-signal.ts'
import type { StopReason } from './process.ts'
import type { SupervisorSpec, writeReceipt } from './supervisor.mjs'
import type { CodingEvent, LineParser } from './types.ts'
import type { ManagerIncarnation, Population, RunTool } from './units.ts'

export type BackendKind = 'unit' | 'process-group'

export interface BackendStatus {
  kind: BackendKind
  checks: { name: string; ok: boolean; detail: string }[]
  checkedAt: string
  /** One calm sentence for the coding agent card (docs/WRITING.md). */
  note: string
}

export interface UnitBackendDeps {
  db: ScoreDb
  journal: CodingJournal
  installationId: string
  /** `<journal dir>/<installation id>`: receipts live under `launches/<launch id>/`, outside the home. */
  namespaceDir: string
  /** `$XDG_RUNTIME_DIR`. */
  runtimeDir: string
  /** HOME of the units (the person's own home, where the CLIs keep their logins). */
  home: string
  /** Why coding admission is paused (hard block, journal fence, orphan units), or null. Evaluated at every admission. */
  blocked?: () => string | null
  /**
   * Why Score holds all agent work (decision 71: an unresolved or copied home, a lost or truncated journal), as the
   * sentence the person reads, or null. While non-null nothing is admitted, recovered or signalled.
   */
  frozen?: () => string | null
  /**
   * Why runs can't be supervised on this host or in this setup (forced fallback, no runtime directory, unresolved
   * installation). The backend then stays on the fallback, but it still reconciles the unit inventory and the journal
   * and still enforces the admission barriers (`blocked`, orphans, held launches): the barriers don't depend on the
   * backend that launches (review #5).
   */
  disabled?: string
  /**
   * The fallback was asked for (SCORE_CODING_BACKEND). That is a choice, not a failure: it never pauses coding even on an
   * installation that has passed the unit check (decision 69).
   */
  forced?: boolean
  /**
   * The installation isn't resolved (`installationId` is a placeholder): nothing is reconciled or acted on, because the
   * journal and the unit prefix don't belong to this home yet. Only the `blocked` barrier applies.
   */
  unresolved?: boolean
  run?: RunTool
  clock?: () => number
  onError?: (error: unknown) => void
  /** A launch's end proof was just recorded for this run (late proof: the executor reconciles its attempt now). */
  onEnded?: (runId: string) => void
  /** Test seams. */
  /** The write primitives of the capability marker (a test makes the disk fail). */
  markerIo?: Parameters<typeof writeReceipt>[3]
  unitPrefix?: string
  socket?: CodingSocketServer
  node?: string
  supervisor?: string
  python?: string | null
  wrapper?: string
  notifyBin?: string | null
  notifySocket?: string
  population?: (controlGroup: string) => Population
  proc?: {
    start(pid: number): string | null
    cgroup(pid: number, claimed: string): string | null
    boot(): string | null
  }
  manager?: () => Promise<ManagerIncarnation | null>
  /**
   * Signals the recorded supervisor through a pidfd that pins pid + start time (review 2026-10-12 #5). The only way
   * Score stops a unit it holds no connection to; it never stops by unit name. Tests inject a fake.
   */
  signalSupervisor?: (pid: number, start: string, signal: NodeJS.Signals) => PidSignalResult
  /** Merged into the supervisor's spec before it is hashed (tests tighten its ticks). */
  specOverrides?: Partial<SupervisorSpec>
  readyTimeoutMs?: number
  proofTimeoutMs?: number
  /** How long recovery waits for one launch's end before holding it (default 10 s). */
  recoverProofMs?: number
  pollMs?: number
  launchesPerMinute?: number
  probeProperties?: boolean
  graceMs?: number
}

export interface UnitLaunchRequest {
  agentId: string
  runtime: string
  runId: string
  turnId: string
  /** Launch attempt within the turn (0, then 1 after a refused resume). */
  generation: number
  command: {
    file: string
    args: string[]
    env: Record<string, string>
    cwd: string
    stdin: string
  }
  parser: LineParser
  /** Bytes the caller keeps for this run besides the parser (the translator's call details): charged to the budget. */
  retainedBytes?(): number
  /** Processes one parsed event, strictly in order. A rejection makes the result ineligible and stops the run. */
  onEvent(event: CodingEvent): Promise<void>
  /** Wall-clock deadline of the whole turn (epoch ms), shared by every launch attempt. */
  deadline: number
  graceMs: number
  /** Re-evaluated inside the release critical section: not stopped, runtime open, agent not held. */
  authorised(): boolean
  /** The CLI was released (`go` sent). */
  onReleased?(launchId: string): void
  /**
   * Orchestration-owned launches (7.7b §5, §6). `launchId` is the id the executor minted for this dispatch generation
   * (one launch per generation, journaled with its `send_started`); `owner` is written into the `requested` record and
   * stays with the launch forever; `authorise` is the executor's decision at the ordering point: it runs inside the
   * release critical section, in its own read transaction, and answers with a typed cause when it says no. `prepared`
   * is what this launch was prepared with (its absolute expiry).
   */
  launchId?: string
  owner?: { orchestrationId: string; attemptId: string; generation: number }
  authorise?(prepared: PreparedLaunch, journal: OwnedLaunchJournal): ReleaseDecision
  /** The id of the worker policy the invocation was built from (7.7b §3); handed to `authorise` with the expiry. */
  preparedPolicyId?: string
}

export interface UnitOutcome {
  /** The typed cause when the launch ended before the CLI (revoked, or refused before it was requested), else null. */
  refusalCause: string | null
  launchId: string
  unit: string
  /** `go` was sent: the CLI may have run. */
  released: boolean
  exitCode: number | null
  signal: string | null
  stopped: StopReason | null
  stderr: string
  /** Why the launch ended before the CLI, in words for the run's failure note; null when it ran. */
  refusal: string | null
  /** The stdout stream was complete and every record processed (§4). */
  complete: boolean
  reasons: string[]
  /** Something outlived the CLI inside the unit and was killed with the unit's cgroup. */
  leftovers: boolean
  /** Ended proof (§6) was obtained. */
  proven: boolean
  proof: string | null
  stats: LineParser['stats']
  sawEvents: boolean
}

export interface UnitRun {
  readonly launchId: string
  stop(reason?: StopReason): void
  done: Promise<UnitOutcome>
}

export interface RecoveredLaunch {
  launchId: string
  runId: string
  agentId: string | null
  /** The launch's end is proven: the run may be settled. */
  ended: boolean
  mayHaveExecuted: boolean
}
export interface RecoveryReport {
  launches: RecoveredLaunch[]
  /** Units with this installation's prefix that no journal launch owns (never adopted). */
  orphans: string[]
  /** The inventory or the journal could not be read: nothing was concluded. */
  unreadable: string | null
}

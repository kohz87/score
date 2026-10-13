import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import type { CodingJournal, ReleaseDecision } from '../../domain/orchestration/coding-journal.ts'
import {
  foldCodingLaunches,
  type CodingLaunch,
  type CodingState,
} from '../../domain/orchestration/coding-records.ts'
import { fenceItems, isFenced } from '../../domain/orchestration/fence.ts'
import { installation8, LAUNCHES_DIR } from '../../installation.ts'
import { mkdirDurable } from '../../locks/os-lock.ts'
import { CodingSocketServer, RETAINED_RUN_BYTES, type RunSession } from './coding-socket.ts'
import { BoundedDiagnostics, redactNote } from './note.ts'
import { signalPid, type PidSignalResult } from './pidfd-signal.ts'
import { bootId, processStart } from './proc.ts'
import { pdeathsigSupport } from './pdeathsig-exec.ts'
import type { StopReason } from './process.ts'
import {
  hashSpec,
  parseReceipt,
  syncReceipt,
  writeReceipt,
  type SupervisorSpec,
} from './supervisor.mjs'
import type { CodingEvent, LineParser } from './types.ts'
import {
  buildSystemRun,
  cgroupPopulation,
  checkCapabilities,
  hasInstallationPrefix,
  listInstallationUnits,
  managerEnvironmentNames,
  managerIncarnation,
  realRunTool,
  resetUnit,
  showUnit,
  unitNameFor,
  unitPrefix,
  type ManagerIncarnation,
  type Population,
  type RunTool,
  type UnitState,
} from './units.ts'

// Coding runs as supervised systemd user units (7.7a design v7). This module is the Score side of one launch: the
// journal phases, the spec and receipt directories, `systemd-run`, the identity check, the ordering point, the wire
// session, the ended proof, settlement and collection, and the recovery of launches a restart left behind.
// `service.ts` decides *whether* to use it (the capability check) and what a finished run means for the person.

/** Policy, not protocol: how many units one installation may start per minute (unique names bypass systemd's own counters, §6b). */
export const LAUNCHES_PER_MINUTE = 30
const SUPERVISOR_FILE = fileURLToPath(new URL('./supervisor.mjs', import.meta.url))
const WRAPPER_FILE = fileURLToPath(new URL('./pdeathsig-exec.py', import.meta.url))

export type BackendKind = 'unit' | 'process-group'

/** A file the installation keeps (beside its journal, outside the home) once the unit check has passed (decision 69). */
export const UNIT_CAPABLE_FILE = 'unit-capable.json'
const MARKER_PAUSE =
  'Coding runs are paused: Score couldn’t save that this computer runs supervised services, and it won’t start a run until it has. Check the disk and choose Check again.'
/** Written before `requested`: where the launch belongs, so a restored database that lost its rows can still route it. */
const ROUTING_FILE = 'routing.json'
/** The supervisor's first stop cause, written before it acts on it (review 2026-10-12 #17). */
const STOP_RECEIPT = 'stop-cause.json'

/**
 * Coding admission barrier from the fence (review 2026-10-12 #2): an unresolved restore, journal or installation
 * uncertainty, or a coding item, stops every coding launch, whichever engine launches and also inside release. Items
 * about orchestration attempts alone don't concern coding. This is the production callback; tests call it as it is.
 */
export function fenceBarrier(sqlite: DatabaseSync): string | null {
  if (!isFenced(sqlite)) return null
  const blocking = fenceItems(sqlite).some(
    (item) => item.kind === 'restore' || item.kind === 'journal' || item.ref.startsWith('coding'),
  )
  return blocking
    ? 'Score is waiting for you to review the execution journal before it starts coding runs.'
    : null
}
/**
 * Whether the environment forces the process-group engine. Only the test harness may (decision 70): in production a
 * host that ever ran supervised services never silently loses them, whatever the environment says.
 */
export function fallbackForced(env: NodeJS.ProcessEnv): boolean {
  return env.SCORE_CODING_BACKEND === 'process-group' && env.NODE_ENV === 'test'
}
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
  authorise?(prepared: { expiry: number }): ReleaseDecision
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

export const STOP_CAUSE: Record<StopReason, string> = {
  user: 'user',
  timeout: 'deadline',
  output_limit: 'output-cap',
  shutdown: 'score-shutdown',
}
function reasonOfCause(cause: string | null): StopReason | null {
  switch (cause) {
    case 'user':
    case 'cancel':
    case 'stop':
      return 'user'
    case 'deadline':
      return 'timeout'
    case 'output-cap':
    case 'run-cap':
      return 'output_limit'
    case 'score-shutdown':
    case 'unit-stop':
      return 'shutdown'
    default:
      return null
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Extra = Partial<
  Record<
    'manager' | 'stop_cause' | 'eligibility' | 'held' | 'deadline_at' | 'receipt_dir' | 'spec_dir',
    string | number | null
  >
>
const EXTRA_COLUMNS = new Set([
  'manager',
  'stop_cause',
  'eligibility',
  'held',
  'deadline_at',
  'receipt_dir',
  'spec_dir',
])

interface Row {
  launch_id: string
  run_id: string
  agent_id: string | null
  unit: string | null
  invocation_id: string | null
  cgroup: string | null
  manager: string | null
  receipt_dir: string | null
  phase: string
  revoked: number
  may_have_executed: number
  held: number
}

const RoutingFile = z.object({
  launch: z.string().min(1),
  generation: z.number().int(),
  agentId: z.string().min(1),
  runtime: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
})

const IDENTITY_FILE = 'identity.json'
const IdentityFile = z.object({
  launch: z.string().min(1),
  generation: z.number().int(),
  at: z.number(),
  unit: z.string().min(1),
  invocationId: z.string().min(1),
  cgroup: z.string().min(1),
  boot: z.string().nullable(),
  manager: z.object({ pid: z.number().int(), start: z.string() }).nullable(),
  supervisor: z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/) }),
})

/** Everything Score recorded about one launch, merged from the journal, the identity file and the database row. */
interface RecordedLaunch {
  launchId: string
  unit: string | null
  invocationId: string | null
  cgroup: string | null
  boot: string | null
  /** `<pid>:<start>` of the user manager that verified the launch. */
  manager: string | null
  supervisor: { pid: number; start: string } | null
  /** Any source knows the launch. */
  known: boolean
  /** Names of the fields two sources disagree on, or null. */
  disagreement: string | null
  receiptDir: string
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

export class UnitBackend {
  readonly socket: CodingSocketServer
  private readonly run: RunTool
  private readonly clock: () => number
  private readonly prefix: string
  private readonly starts: number[] = []
  private current: BackendStatus
  private socketError: string | null = null
  /** The installation has passed the unit check at least once (the marker file). */
  private capable = false
  /** Why runs are paused: the unit check failed on an installation that passed it before. */
  private paused: string | null = null
  /** The pass is known but its marker file isn't durable yet: no unit launch until it is (decision 70). */
  private markerPending = false
  /** Launches whose stop cause couldn't be made durable: their result can't be eligible. */
  private readonly unrecordedStops = new Set<string>()
  private closed = false
  private orphans: string[] = []
  private readonly reapers = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: UnitBackendDeps) {
    this.run = deps.run ?? realRunTool
    this.clock = deps.clock ?? Date.now
    this.prefix = deps.unitPrefix ?? unitPrefix(deps.installationId)
    this.socket =
      deps.socket ??
      new CodingSocketServer({
        runtimeDir: deps.runtimeDir,
        installationId: deps.installationId,
        ...(deps.frozen ? { frozen: deps.frozen } : {}),
      })
    this.current = {
      kind: 'process-group',
      checks: [],
      checkedAt: new Date(this.clock()).toISOString(),
      note: FALLBACK_NOTE,
    }
    this.capable =
      !deps.unresolved &&
      (existsSync(join(deps.namespaceDir, UNIT_CAPABLE_FILE)) || this.historyShowsUnits())
    // Evidence from owned history stands in for a lost marker; write it back (best effort, it is also retried).
    if (this.capable && !deps.unresolved && deps.disabled === undefined) this.markerPending = true
  }

  /**
   * Positive evidence that this installation ran supervised services: an owned unit launch in its database or journal.
   * A history that can't be read counts as evidence (pausing is the safe side of the choice).
   */
  private historyShowsUnits(): boolean {
    try {
      if (
        this.deps.db.sqlite
          .prepare("SELECT 1 FROM coding_launches WHERE backend = 'unit' LIMIT 1")
          .get() !== undefined
      )
        return true
    } catch {
      return true
    }
    const read = this.deps.journal.journal.readOwn()
    if (!read.ok) return true
    for (const launch of foldCodingLaunches(read.entries).values())
      if (launch.state.inherited !== true) return true
    return false
  }

  get status(): BackendStatus {
    return this.current
  }
  /** True when new coding runs should use the unit backend. */
  usable(): boolean {
    this.retryMarker()
    return this.current.kind === 'unit' && this.paused === null && !this.closed
  }
  /** Why admission is paused, or null. */
  block(): string | null {
    const frozen = this.deps.frozen?.() ?? null
    if (frozen !== null) return frozen
    this.retryMarker()
    if (this.paused !== null) return this.paused
    if (this.orphans.length > 0)
      return 'A coding service from an earlier session isn’t accounted for. Score paused coding runs until you review it.'
    if (this.unattributed())
      return 'Score can’t tell which agent an unfinished coding run belonged to. It paused all coding runs until you review it.'
    return this.deps.blocked?.() ?? null
  }

  /** An owned launch that may still be running and that no agent can be named for: it fences every coding agent. */
  private unattributed(): boolean {
    if (this.deps.unresolved) return false
    try {
      return (
        this.deps.db.sqlite
          .prepare(
            "SELECT 1 FROM coding_launches WHERE backend = 'unit' AND agent_id IS NULL AND held > 0 AND phase NOT IN ('ended','settled') LIMIT 1",
          )
          .get() !== undefined
      )
    } catch {
      return true
    }
  }
  get orphaned(): readonly string[] {
    return this.orphans
  }

  // ---- startup and capability ------------------------------------------------------------------------------------

  /** Starts the socket listener and runs the capability check. Never throws: a failure means the fallback backend. */
  async start(): Promise<BackendStatus> {
    if (this.deps.disabled === undefined) {
      try {
        // Held by the caller: the home lock keeps a second Score off this installation's socket (design §4).
        await this.socket.start(true)
      } catch (error) {
        this.socketError = error instanceof Error ? error.message : String(error)
      }
    }
    return this.check()
  }
  /** "Check again": the same check, on demand. */
  async check(): Promise<BackendStatus> {
    await this.rescanOrphans()
    if (this.deps.disabled !== undefined) {
      const checks = [{ name: 'manager', ok: false, detail: this.deps.disabled }]
      this.current = this.shortfall(checks, this.deps.disabled)
      return this.current
    }
    const checks: { name: string; ok: boolean; detail: string }[] = []
    let ok: boolean
    try {
      const result = await checkCapabilities({
        run: this.run,
        socketPath: this.socket.path,
        probeProperties: this.deps.probeProperties ?? true,
        graceMs: this.deps.graceMs ?? 5000,
      })
      checks.push(...result.checks)
      ok = result.ok
    } catch (error) {
      checks.push({
        name: 'manager',
        ok: false,
        detail: `the check failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      ok = false
    }
    const listening = this.socketError === null
    checks.push({
      name: 'socket',
      ok: listening,
      detail: listening
        ? 'Score is listening for supervisors'
        : `couldn’t listen: ${this.socketError}`,
    })
    const python = this.deps.python === undefined ? pdeathsigSupport().python : this.deps.python
    checks.push({
      name: 'python',
      ok: python !== null,
      detail: python !== null ? `Python at ${python}` : 'Python 3 is needed to start a coding CLI',
    })
    const notify = this.notifySocket()
    const notifyBin =
      this.deps.notifyBin === undefined ? '/usr/bin/systemd-notify' : this.deps.notifyBin
    // The watchdog needs both: the manager's notify socket and the tool that pings it.
    const notifyOk =
      (this.deps.notifySocket !== undefined || existsSync(notify)) &&
      (notifyBin === null || existsSync(notifyBin))
    checks.push({
      name: 'notify',
      ok: notifyOk,
      detail: notifyOk
        ? 'the manager’s notify socket and systemd-notify exist'
        : `no notify socket at ${notify}, or no ${notifyBin}`,
    })
    const all = ok && listening && python !== null && notifyOk
    if (all) {
      this.paused = null
      this.capable = true
      this.markerPending = !this.persistCapable()
      this.current = {
        kind: 'unit',
        checks,
        checkedAt: new Date(this.clock()).toISOString(),
        note: UNIT_NOTE,
      }
      if (this.markerPending) this.pauseForMarker()
    } else this.current = this.shortfall(checks, checks.find((c) => !c.ok)?.detail ?? '')
    return this.current
  }

  /**
   * The check isn't met. An installation that passed it before is paused (decision 69): no fallback behind its back, the
   * card says why and offers Check again. One that never passed (or was told to use the fallback) runs without a
   * supervisor, with the weaker guarantee stated.
   */
  private shortfall(checks: BackendStatus['checks'], detail: string): BackendStatus {
    const checkedAt = new Date(this.clock()).toISOString()
    if (this.capable && this.deps.forced !== true) {
      this.paused = `Coding runs are paused: this computer no longer meets what supervised services need${detail ? ` (${detail})` : ''}. Fix that and choose Check again.`
      return { kind: 'unit', checks, checkedAt, note: this.paused }
    }
    this.paused = null
    return {
      kind: 'process-group',
      checks,
      checkedAt,
      note: `${FALLBACK_NOTE} ${detail}`.trim(),
    }
  }

  /** Whether the marker file exists durably afterwards. Never throws. */
  private persistCapable(): boolean {
    if (this.deps.unresolved || this.deps.disabled !== undefined) return true
    try {
      writeReceipt(
        this.deps.namespaceDir,
        UNIT_CAPABLE_FILE,
        { installation: this.deps.installationId, at: this.clock() },
        this.deps.markerIo,
      )
      return true
    } catch (error) {
      // A marker that exists is not yet one that survives a crash: its writer's directory sync may have failed (the name
      // is there, the sync threw). It counts only once it reads as ours and its contents and directory sync again.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.syncExistingMarker()
      this.deps.onError?.(error)
      return false
    }
  }

  private syncExistingMarker(): boolean {
    try {
      const body: unknown = JSON.parse(
        readFileSync(join(this.deps.namespaceDir, UNIT_CAPABLE_FILE), 'utf8'),
      )
      if (
        typeof body !== 'object' ||
        body === null ||
        (body as { installation?: unknown }).installation !== this.deps.installationId
      )
        throw new Error('the capability marker isn’t this installation’s')
      syncReceipt(this.deps.namespaceDir, UNIT_CAPABLE_FILE, this.deps.markerIo)
      return true
    } catch (error) {
      this.deps.onError?.(error)
      return false
    }
  }

  private pauseForMarker(): void {
    this.paused = MARKER_PAUSE
    this.current = { ...this.current, kind: 'unit', note: this.paused }
  }

  /** Retries the marker while it is pending; once durable the pause lifts (the check itself had passed). */
  private retryMarker(): void {
    if (!this.markerPending || this.closed) return
    if (!this.persistCapable()) return
    this.markerPending = false
    if (this.paused === MARKER_PAUSE) {
      this.paused = null
      this.current = { ...this.current, note: UNIT_NOTE }
    }
  }

  /** An orphan the person has dealt with (the unit is gone) no longer pauses admission. A failed read changes nothing. */
  private async rescanOrphans(): Promise<void> {
    if (this.orphans.length === 0) return
    const inventory = await listInstallationUnits(this.run, this.prefix)
    if (inventory.kind === 'ok')
      this.orphans = this.orphans.filter((n) => inventory.names.includes(n))
  }

  private notifySocket(): string {
    return this.deps.notifySocket ?? join(this.deps.runtimeDir, 'systemd', 'notify')
  }

  async close(): Promise<void> {
    this.closed = true
    await this.socket.shutdown()
  }

  // ---- launch ----------------------------------------------------------------------------------------------------

  launch(request: UnitLaunchRequest): UnitRun {
    const launchId = request.launchId ?? randomUUID()
    const ctl = new Control(launchId)
    const done = this.drive(launchId, request, ctl).catch((error: unknown) => {
      this.deps.onError?.(error)
      return this.outcomeOf(launchId, '', {
        refusal: `Could not start the supervised run: ${error instanceof Error ? error.message : String(error)}`,
        refusalCause: 'start_failed',
        stats: request.parser.stats,
      })
    })
    return { launchId, stop: (reason = 'user') => ctl.requestStop(reason, this), done }
  }

  /**
   * The first stop cause is saved before any signal goes out, so a Score that dies between the request and the end of
   * the run still knows why it stopped. It goes into the installation's journal first (an fsynced record outside the
   * restorable home; review 2026-10-12 #14) and into the database after it. The first cause wins. A failed write is
   * reported and the stop goes ahead: stopping matters more than the note.
   */
  recordStop(launchId: string, reason: StopReason): void {
    this.recordCause(launchId, STOP_CAUSE[reason])
  }

  /**
   * The same for any stop Score starts on its own account (a broken bound, an ingestion failure, shutdown, or a cause the
   * supervisor reported first). A cause that couldn't be made durable is not lost silently: the launch is remembered as
   * having an unrecorded stop, so its result can't be eligible and the person sees why.
   */
  recordCause(launchId: string, cause: string): void {
    let recorded = true
    try {
      const journaled = this.deps.journal.recordStop(
        launchId,
        cause,
        codingProjection(this.deps.db, this.clock, (sqlite) =>
          sqlite
            .prepare(
              'UPDATE coding_launches SET stop_cause = COALESCE(stop_cause, ?) WHERE launch_id = ?',
            )
            .run(cause, launchId),
        ),
      )
      // A launch the journal doesn't know yet (stopped before `requested`) has nothing to record; an inherited one is
      // not ours.
      if (
        !journaled.ok &&
        journaled.reason !== 'unknown_launch' &&
        journaled.reason !== ('inherited' as string)
      ) {
        recorded = false
        this.deps.onError?.(new Error(`stop cause not journaled: ${journaled.reason}`))
      }
    } catch (error) {
      recorded = false
      this.deps.onError?.(error)
    }
    try {
      this.deps.db.sqlite
        .prepare(
          'UPDATE coding_launches SET stop_cause = COALESCE(stop_cause, ?) WHERE launch_id = ?',
        )
        .run(cause, launchId)
    } catch (error) {
      this.deps.onError?.(error)
    }
    if (!recorded) this.unrecordedStops.add(launchId)
  }

  /**
   * The first cause a supervisor wrote before acting on its own (deadline, socket loss, systemd's stop) becomes part of
   * the journal, if Score didn't already hold one, before the launch is ended.
   */
  private adoptStopReceipt(launchId: string): void {
    const rec = this.recorded(launchId)
    let text: string
    try {
      text = readFileSync(join(rec.receiptDir, STOP_RECEIPT), 'utf8')
    } catch (error) {
      // No receipt is the common case. One that exists but can't be read is uncertainty about why the run stopped.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.stopReceiptProblem(launchId, error)
      return
    }
    const generation = this.deps.journal.state(launchId)?.state.generation
    let body: { launch?: unknown; generation?: unknown; cause?: unknown }
    try {
      body = JSON.parse(text) as typeof body
    } catch (error) {
      this.stopReceiptProblem(launchId, error)
      return
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      body.launch !== launchId ||
      generation === undefined ||
      body.generation !== generation ||
      typeof body.cause !== 'string' ||
      body.cause === '' ||
      body.cause.length > 64
    ) {
      this.stopReceiptProblem(launchId, new Error('the stop-cause receipt is not for this launch'))
      return
    }
    if (this.deps.journal.state(launchId)?.state.stopCause !== undefined) return
    this.recordCause(launchId, body.cause)
  }

  /** A receipt that can't be trusted: reported, and the launch's result can't be eligible (visible uncertainty). */
  private stopReceiptProblem(launchId: string, error: unknown): void {
    this.unrecordedStops.add(launchId)
    this.deps.onError?.(
      new Error(
        `stop-cause receipt of ${launchId} unusable: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }

  /**
   * Called by `Control.requestStop` once a session exists and the CLI is released, after `recordStop`. The stop goes over
   * the authenticated connection; without one, to the recorded supervisor through its pidfd. Never by unit name.
   */
  sendStop(launchId: string, session: RunSession | null, reason: StopReason): void {
    // The cause is already recorded. A connected session is a launch this process made (its supervisor proved the
    // single-use token issued for it), so its Stop — the person's, the deadline's or a cap's — goes out even while Score
    // holds all agent work (decision 74). Signals to a recorded supervisor don't: that one may not be ours, and its own
    // disconnect and watchdog containment still ends the CLI.
    if (session?.connected) session.stop(STOP_CAUSE[reason])
    else if (this.deps.frozen?.() != null) return
    else void this.stopSupervisor(launchId).catch((error: unknown) => this.deps.onError?.(error))
  }

  private outcomeOf(
    launchId: string,
    unit: string,
    over: Partial<UnitOutcome> & { stats: LineParser['stats'] },
  ): UnitOutcome {
    return {
      refusalCause: null,
      launchId,
      unit,
      released: false,
      exitCode: null,
      signal: null,
      stopped: null,
      stderr: '',
      refusal: null,
      complete: false,
      reasons: [],
      leftovers: false,
      proven: false,
      proof: null,
      sawEvents: false,
      ...over,
    }
  }

  private projection(
    request: { agentId: string; runtime: string },
    receiptDir: string,
    specDir: string,
    extra: Extra = {},
  ) {
    return (launchId: string) =>
      codingProjection(this.deps.db, this.clock, (sqlite) => {
        const sets = [
          'backend = ?',
          'agent_id = ?',
          'runtime = ?',
          'receipt_dir = ?',
          'spec_dir = ?',
        ]
        const values: (string | number | null)[] = [
          'unit',
          request.agentId,
          request.runtime,
          receiptDir,
          specDir,
        ]
        for (const [column, value] of Object.entries(extra)) {
          if (!EXTRA_COLUMNS.has(column)) continue
          // The first stop cause stays: a projection never overwrites an adopted cause (FW #9).
          sets.push(
            column === 'stop_cause' ? 'stop_cause = COALESCE(stop_cause, ?)' : `${column} = ?`,
          )
          values.push(value ?? null)
        }
        sqlite
          .prepare(`UPDATE coding_launches SET ${sets.join(', ')} WHERE launch_id = ?`)
          .run(...values, launchId)
      })
  }

  private tooFast(): boolean {
    const now = this.clock()
    while (this.starts.length > 0 && now - this.starts[0]! > 60_000) this.starts.shift()
    if (this.starts.length >= (this.deps.launchesPerMinute ?? LAUNCHES_PER_MINUTE)) return true
    this.starts.push(now)
    return false
  }

  private async drive(
    launchId: string,
    request: UnitLaunchRequest,
    ctl: Control,
  ): Promise<UnitOutcome> {
    const { journal } = this.deps
    const stats = request.parser.stats
    const unit = unitNameFor(this.deps.installationId, launchId, this.prefix)
    const receiptDir = join(this.deps.namespaceDir, LAUNCHES_DIR, launchId)
    const specDir = join(
      this.deps.runtimeDir,
      'score',
      installation8(this.deps.installationId),
      LAUNCHES_DIR,
      launchId,
    )
    const refuse = (refusal: string, cause: string) =>
      this.outcomeOf(launchId, unit, { refusal, refusalCause: cause, stats })
    if (this.tooFast())
      return refuse('Score is starting coding runs too quickly. Try again in a minute.', 'hold')
    const blocked = this.block()
    if (blocked) return refuse(blocked, 'fenced')
    if (ctl.stopReason) return refuse('Stopped before it started.', 'stop')

    // Per-launch directories before `requested`: the receipt directory outside the home (each parent fsynced), and the
    // spec directory in the runtime dir (0700). Nothing external has happened yet, so a failure is a plain refusal.
    try {
      mkdirDurable(receiptDir)
      mkdirSync(specDir, { recursive: true, mode: 0o700 })
      // Where the launch belongs, outside the restorable database and before the journal knows it (review #7).
      writeReceipt(receiptDir, ROUTING_FILE, {
        launch: launchId,
        generation: request.generation,
        at: this.clock(),
        agentId: request.agentId,
        runtime: request.runtime,
        runId: request.runId,
        turnId: request.turnId,
      })
    } catch (error) {
      return refuse(`Couldn’t prepare the run’s folders: ${errorText(error)}`, 'start_failed')
    }
    const identity = {
      launchId,
      runId: request.runId,
      turnId: request.turnId,
      generation: request.generation,
    }
    const project = this.projection(request, receiptDir, specDir, {
      deadline_at: request.deadline,
    })
    const requested = journal.requestLaunch(identity, project(launchId), {
      unit,
      ...(request.owner ? { owner: request.owner } : {}),
    })
    if (!requested.ok) {
      this.removeSpecDir(specDir)
      return refuse(`Couldn’t record the run (${requested.reason}).`, 'start_failed')
    }

    // ---- from here the launch is journaled: every exit goes through `end()` ----
    let session: RunSession | null = null
    let released = false
    const diagnostics = new BoundedDiagnostics()
    const finish = async (
      over: Partial<UnitOutcome> = {},
      stopCause: string | null = null,
    ): Promise<UnitOutcome> => {
      const proof = await this.proveAndEnd(launchId, request, receiptDir, specDir, {
        stopCause: ctl.stopReason ? STOP_CAUSE[ctl.stopReason] : stopCause,
      })
      this.removeSpecDir(specDir)
      const outcome = this.outcomeOf(launchId, unit, {
        released,
        stderr: diagnostics.text(),
        stats,
        proven: proof.proven,
        proof: proof.proof,
        stopped: ctl.stopReason,
        ...over,
      })
      if (outcome.complete) {
        // Eligibility also needs the unit's own account of its supervisor: it exited with status 0 (#10), and every stop
        // cause was made durable (#17).
        const exit = await this.supervisorExit(launchId)
        // The supervisor writes its final receipt after reading `ack-end`: positive evidence that Score's acknowledgment
        // was consumed (FW #4), nothing more. Missing unit metadata is uncertainty, never "clean", and no receipt flag
        // stands in for it: a publication that failed may still leave its name behind (FU #1).
        const acked = this.ackedReceipt(this.recorded(launchId))
        // A unit that exited 0 is garbage-collected at once while a failed one stays, so absence is the clean exit only
        // while the manager is the very one that verified the launch. A replaced or unreadable manager forgets failures
        // too, and absence then proves nothing (FU #1).
        const absentIsClean = exit === 'absent' && (await this.managerUnchanged(launchId))
        if (!proof.proven || (exit !== 'clean' && !absentIsClean)) {
          outcome.complete = false
          outcome.reasons = [
            ...outcome.reasons,
            `supervisor-exit:${proof.proven ? exit : 'unproven'}`,
          ]
        } else if (acked === 'missing') {
          outcome.complete = false
          outcome.reasons = [...outcome.reasons, 'supervisor-exit:unacknowledged']
        }
        if (this.unrecordedStops.has(launchId)) {
          outcome.complete = false
          outcome.reasons = [...outcome.reasons, 'stop-unrecorded']
        }
        // The first stop cause is authoritative wherever it came from: Score's own stop or one the supervisor recorded
        // first and Score adopted from its receipt. A run that something stopped never completes, whatever else the
        // control or session view says (FV #3); the cause stays visible in the reasons.
        const cause =
          this.deps.journal.state(launchId)?.state.stopCause ?? this.storedStopCause(launchId)
        if (cause !== null) {
          outcome.complete = false
          outcome.reasons = [...outcome.reasons, `stop-cause:${cause}`]
        }
      }
      this.unrecordedStops.delete(launchId)
      return outcome
    }
    const abort = async (reason: string, cause: string): Promise<UnitOutcome> => {
      // Nothing was released. Revoke if the journal still allows it (no `releasing`), cancel/stop, then prove.
      const revoked = journal.revoke(launchId, undefined, project(launchId), cause)
      if (
        !revoked.ok &&
        revoked.reason !== 'may_have_executed' &&
        revoked.reason !== 'illegal_transition'
      )
        this.deps.onError?.(new Error(`revoke refused: ${revoked.reason}`))
      this.socket.forget(launchId)
      try {
        if (session?.connected) session.cancel()
      } catch {
        // the unit stop below ends it
      }
      // A supervisor that never reported has nothing to pin: its launch is unknown to Score now, so it is rejected and
      // leaves by itself; the proof below waits for that. One that reported is stopped through its pidfd.
      await this.stopSupervisor(launchId)
      return finish({ refusal: reason, refusalCause: cause })
    }

    let sawEvents = false
    const handlers = {
      onStdoutRecord: async (line: string) => {
        const events = request.parser.parse(line)
        if (events.length) sawEvents = true
        for (const event of events) await request.onEvent(event)
      },
      onStderr: (text: string) => diagnostics.push(text),
      // Score's own stops (a bound, an ingestion failure, shutdown) are made durable before the frame goes out (#17).
      onStop: (cause: string) => this.recordCause(launchId, cause),
      // What the parser really keeps, charged to the installation's budget (#18). Drivers that don't report it keep the
      // fixed reservation.
      retainedBytes: () =>
        ((request.parser as { retainedBytes?: () => number }).retainedBytes?.() ?? 0) +
        (request.retainedBytes?.() ?? 0) +
        diagnostics.size,
    }

    // ---- spec, token, unit ----
    const home = this.deps.home
    const spec: SupervisorSpec = {
      launch: launchId,
      generation: request.generation,
      token: '',
      socket: this.socket.path,
      receiptDir,
      command: {
        file: request.command.file,
        args: request.command.args,
        env: request.command.env,
        cwd: request.command.cwd,
        stdin: request.command.stdin,
      },
      graceMs: request.graceMs,
      deadline: request.deadline,
      python:
        (this.deps.python === undefined ? pdeathsigSupport().python : this.deps.python) ??
        undefined,
      wrapper: this.deps.wrapper ?? WRAPPER_FILE,
      notifyBin:
        this.deps.notifyBin === undefined ? '/usr/bin/systemd-notify' : this.deps.notifyBin,
      ...this.deps.specOverrides,
    }
    let registered: ReturnType<CodingSocketServer['expect']>
    try {
      registered = this.socket.expect({
        launch: launchId,
        generation: request.generation,
        specHash: hashSpec(spec),
        handlers,
        retainedBytes: RETAINED_RUN_BYTES,
        // Kept until the caller hands the run's result over (`holdDelivery`): proof and delivery still retain state.
        holdAfterOutcome: true,
      })
      this.reservations.set(request.runId, [
        ...(this.reservations.get(request.runId) ?? []),
        launchId,
      ])
      // No timed release: the reservation is released when the state it charges is gone (`holdDelivery` replaces it with
      // the delivery charge, `releaseDelivery`, the run's settlement or shutdown). A timer would uncharge memory a
      // run still retains.
    } catch {
      return abort(
        'Score is holding too much coding output in memory right now. Try again shortly.',
        'hold',
      )
    }
    session = registered.session
    spec.token = registered.token
    const specPath = join(specDir, 'spec.json')
    try {
      writeFileSync(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      return abort(`Couldn’t write the run’s settings: ${errorText(error)}`, 'start_failed')
    }
    if (ctl.stopReason) return abort('Stopped before it started.', 'stop')

    const started = await (async () => {
      const names = await managerEnvironmentNames(this.run)
      const cmd = buildSystemRun({
        unit,
        graceMs: request.graceMs,
        remainingTurnMs: request.deadline - this.clock(),
        home,
        node: this.deps.node ?? process.execPath,
        supervisor: this.deps.supervisor ?? SUPERVISOR_FILE,
        spec: specPath,
        notifySocket: this.notifySocket(),
        managerEnvNames: names,
      })
      return this.run(cmd.file, cmd.args, { timeoutMs: 30_000 })
    })()
    if (started.code !== 0) {
      const detail = redactNote(started.stderr.trim(), 160)
      return abort(
        `The system service manager refused to start the run${detail ? ` (${detail})` : ''}.`,
        'start_failed',
      )
    }
    if (ctl.stopReason) return abort('Stopped before it started.', 'stop')

    // ---- hello / ready, then identity (§5) ----
    const ready = await Promise.race([
      session.ready.then((info) => ({ ok: true as const, info })),
      sleep(this.deps.readyTimeoutMs ?? 15_000).then(() => ({
        ok: false as const,
        why: 'timeout',
      })),
      ctl.stopped.then(() => ({ ok: false as const, why: 'stopped' })),
    ]).catch(() => ({ ok: false as const, why: 'closed' }))
    if (!ready.ok)
      return abort(
        ready.why === 'stopped'
          ? 'Stopped before it started.'
          : 'The run’s supervisor didn’t report in.',
        ready.why === 'stopped' ? 'stop' : 'start_failed',
      )
    const verified = await this.verifyIdentity(unit, ready.info)
    if (!verified.ok)
      return abort(`The run’s identity didn’t check out (${verified.reason}).`, 'start_failed')
    const unitState = verified.state
    const manager = await this.managerNow()
    const managerText = manager ? `${this.bootNow() ?? ''}|${manager.pid}:${manager.start}` : null
    // The identity Score verified is also kept beside the journal (outside the restorable home): the supervisor to
    // signal, the boot and the user manager it ran under (review 2026-10-12 #5/#6). Written before `armed`.
    try {
      writeReceipt(receiptDir, IDENTITY_FILE, {
        launch: launchId,
        generation: request.generation,
        at: this.clock(),
        unit,
        invocationId: unitState.invocationId,
        cgroup: ready.info.cgroup,
        boot: this.bootNow(),
        manager: manager ? { pid: manager.pid, start: manager.start } : null,
        supervisor: { pid: ready.info.pid, start: ready.info.start },
      })
    } catch (error) {
      return abort(`Couldn’t record the run’s identity (${errorText(error)}).`, 'start_failed')
    }
    const armed = journal.arm(
      launchId,
      { unit, invocationId: unitState.invocationId, cgroup: ready.info.cgroup },
      this.projection(request, receiptDir, specDir, { manager: managerText })(launchId),
    )
    if (!armed.ok)
      return abort(`Couldn’t record the run’s identity (${armed.reason}).`, 'start_failed')
    // The spec held the single-use token: Score's backstop deletes it now that the supervisor reported in.
    this.removeSpecDir(specDir)
    if (ctl.stopReason) return abort('Stopped before it started.', 'stop')

    // ---- the ordering point (§3) ----
    // A fence raised while the unit was starting also stops the release (review #5). An owned launch asks its owner,
    // inside the critical section and in a read transaction of its own; a refusal is revoked there with its cause.
    const decide = (): ReleaseDecision => {
      if (ctl.stopReason) return { allowed: false, cause: 'stop' }
      if (this.block() !== null) return { allowed: false, cause: 'fenced' }
      if (!request.authorised()) return { allowed: false, cause: 'stop' }
      return request.authorise?.({ expiry: request.deadline }) ?? { allowed: true }
    }
    let releasing: ReturnType<typeof journal.release>
    try {
      releasing = request.authorise
        ? journal.releaseOwned(launchId, decide, project(launchId))
        : journal.release(
            launchId,
            () => !ctl.stopReason && this.block() === null && request.authorised(),
            project(launchId),
          )
    } catch (error) {
      // Nothing was written or sent by a decision that threw: the launch is revoked, not left armed.
      return abort(`Couldn’t release the run (${errorText(error)}).`, 'start_failed')
    }
    if (!releasing.ok) {
      if (releasing.reason === 'projection_failed') {
        // The record is durable: this launch MAY have executed. No `go`; stop it and prove it ended.
        released = false
        this.socket.forget(launchId)
        try {
          session.cancel()
        } catch {
          // stopped by name below
        }
        await this.stopSupervisor(launchId)
        return finish({ refusal: 'Couldn’t save the run’s start. Nothing was sent to the CLI.' })
      }
      return abort(
        releasing.reason === 'not_authorised'
          ? releasing.denied === 'deadline' || releasing.denied === 'deadline_changed'
            ? 'The run’s deadline came before it could start.'
            : 'Stopped before it started.'
          : `Couldn’t release the run (${releasing.reason}).`,
        releasing.denied ?? (releasing.reason === 'not_authorised' ? 'stop' : 'start_failed'),
      )
    }
    released = true
    ctl.attach(session)
    session.go()
    request.onReleased?.(launchId)
    if (ctl.stopReason) this.sendStop(launchId, session, ctl.stopReason)

    // ---- running ----
    const outcome = await session.outcome
    const stopped = ctl.stopReason ?? reasonOfCause(outcome.stopCause)
    const blocking = outcome.reasons.filter((r) => !r.startsWith('stop-cause:'))
    return finish(
      {
        exitCode: outcome.exit?.code ?? null,
        signal: outcome.exit?.signal ?? null,
        stopped,
        complete: outcome.kind === 'ended' && outcome.ackFlushed && blocking.length === 0,
        reasons: outcome.reasons,
        leftovers: outcome.survivorsKilled,
        sawEvents,
        refusal: null,
      },
      outcome.stopCause,
    )
  }

  // ---- identity ----------------------------------------------------------------------------------------------------

  private async verifyIdentity(
    unit: string,
    ready: { pid: number; start: string; cgroup: string },
  ): Promise<{ ok: true; state: UnitState } | { ok: false; reason: string }> {
    const shown = await showUnit(this.run, unit)
    if (shown.kind !== 'present') return { ok: false, reason: 'the unit isn’t visible to systemd' }
    const state = shown.state
    if (state.activeState !== 'active')
      return { ok: false, reason: `the unit is ${state.activeState}` }
    if (state.mainPid !== ready.pid) return { ok: false, reason: 'the main process differs' }
    if (state.controlGroup !== ready.cgroup)
      return { ok: false, reason: 'the control group differs' }
    if (!/^[0-9a-f]{32}$/.test(state.invocationId)) return { ok: false, reason: 'no invocation id' }
    const proc = this.deps.proc ?? {
      start: processStart,
      cgroup: (pid: number) => procCgroup(pid),
      boot: bootId,
    }
    if (proc.start(ready.pid) !== ready.start)
      return { ok: false, reason: 'the start time differs' }
    if (proc.cgroup(ready.pid, ready.cgroup) !== ready.cgroup)
      return { ok: false, reason: '/proc names another cgroup' }
    return { ok: true, state }
  }

  private managerNow(): Promise<ManagerIncarnation | null> {
    return this.deps.manager ? this.deps.manager() : managerIncarnation(this.run)
  }
  private bootNow(): string | null {
    return (this.deps.proc?.boot ?? bootId)()
  }

  // ---- stop and proof ----------------------------------------------------------------------------------------------

  private storedStopCause(launchId: string): string | null {
    const found = this.deps.db.sqlite
      .prepare('SELECT stop_cause FROM coding_launches WHERE launch_id = ?')
      .get(launchId) as { stop_cause: string | null } | undefined
    return found?.stop_cause ?? null
  }

  private rowOf(launchId: string): Row | undefined {
    return this.deps.db.sqlite
      .prepare('SELECT * FROM coding_launches WHERE launch_id = ?')
      .get(launchId) as Row | undefined
  }

  /** Ownership at every stop/reset boundary: this installation's unit-name prefix AND a launch the journal says is ours. */
  private owns(launchId: string, unit: string | null | undefined): boolean {
    if (!unit || !hasInstallationPrefix(unit, this.deps.installationId, this.prefix)) return false
    try {
      return this.deps.journal.isOwned(launchId)
    } catch {
      return false
    }
  }

  /**
   * What Score recorded about a launch, from every place it is recorded: the journal (authoritative for the unit, its
   * InvocationID and cgroup), the identity file beside it (the supervisor, the boot and the user manager; outside the
   * restorable home) and the database row (a projection). Where two sources name different values the launch is in
   * `disagreement`: nothing is concluded from it (review 2026-10-12 #6).
   */
  private recorded(launchId: string): RecordedLaunch {
    const row = this.rowOf(launchId)
    let state: CodingState | undefined
    try {
      state = this.deps.journal.state(launchId)?.state
    } catch {
      // The journal can't be read right now: the other sources stand in, and the caller treats a missing one as unknown.
    }
    const dir = row?.receipt_dir ?? join(this.deps.namespaceDir, LAUNCHES_DIR, launchId)
    const file = this.readIdentity(dir, launchId, state?.generation)
    const rowManager = row?.manager?.split('|') ?? []
    const disagreements: string[] = []
    const agree = (name: string, values: (string | null | undefined)[]): string | null => {
      const present = [...new Set(values.filter((v): v is string => !!v))]
      if (present.length > 1) disagreements.push(name)
      return present[0] ?? null
    }
    const unit = agree('unit', [state?.unit, file?.unit, row?.unit])
    return {
      launchId,
      unit,
      invocationId: agree('invocation', [
        state?.invocationId,
        file?.invocationId,
        row?.invocation_id,
      ]),
      cgroup: agree('cgroup', [state?.cgroup, file?.cgroup, row?.cgroup]),
      boot: file ? file.boot : rowManager[0] || null,
      manager: file
        ? file.manager
          ? `${file.manager.pid}:${file.manager.start}`
          : null
        : rowManager[1] || null,
      supervisor: file?.supervisor ?? null,
      known: state !== undefined || row !== undefined,
      disagreement: disagreements.length > 0 ? disagreements.join(', ') : null,
      receiptDir: dir,
    }
  }

  private readRouting(dir: string, launchId: string) {
    try {
      const file = RoutingFile.parse(JSON.parse(readFileSync(join(dir, ROUTING_FILE), 'utf8')))
      return file.launch === launchId ? file : undefined
    } catch {
      return undefined
    }
  }

  private readIdentity(dir: string, launchId: string, generation: number | undefined) {
    let text: string
    try {
      text = readFileSync(join(dir, IDENTITY_FILE), 'utf8')
    } catch {
      return undefined
    }
    try {
      const file = IdentityFile.parse(JSON.parse(text))
      if (file.launch !== launchId) return undefined
      if (generation !== undefined && file.generation !== generation) return undefined
      return file
    } catch {
      return undefined
    }
  }

  /**
   * Stops a unit's run through a handle that stays pinned to the recorded supervisor: SIGINT through a pidfd that was
   * opened and checked against the recorded pid + start time (the same signal systemd's own stop sends). Never by unit
   * name: between a check and a name-based stop another invocation could take the name (review 2026-10-12 #5). Without
   * a recorded supervisor, pidfd support, or ANY of these that is unknown, nothing is sent and the launch stays uncertain
   * ('unknown'): a known, matching boot (pid and start time can recur across boots), the same user-manager incarnation,
   * and the unit systemd names now carrying the recorded InvocationID, cgroup and main pid (review 2026-10-12 #8). A
   * launch that isn't this installation's is never touched.
   */
  async stopSupervisor(launchId: string): Promise<'signalled' | 'gone' | 'unknown'> {
    // Frozen: whose supervisor this is can't be told; nothing is signalled (decision 71).
    if (this.deps.frozen?.() != null) return 'unknown'
    const rec = this.recorded(launchId)
    if (!this.owns(launchId, rec.unit) || rec.disagreement) return 'unknown'
    if (!rec.supervisor || !rec.unit) return 'unknown'
    // Boot first: a different known boot means the supervisor is long gone; an unknown one proves nothing.
    const bootHere = this.bootNow()
    if (!rec.boot || !bootHere) return 'unknown'
    if (rec.boot !== bootHere) return 'gone'
    // The manager that verified the launch must be the one running now.
    const manager = await this.managerNow()
    if (!rec.manager || !manager || rec.manager !== `${manager.pid}:${manager.start}`)
      return 'unknown'
    // And the unit must still be that invocation, with that supervisor as its main process.
    const shown = await showUnit(this.run, rec.unit)
    if (shown.kind === 'absent') return 'gone'
    if (shown.kind !== 'present') return 'unknown'
    const state = shown.state
    if (
      !rec.invocationId ||
      state.invocationId !== rec.invocationId ||
      (rec.cgroup && state.controlGroup !== rec.cgroup)
    )
      return 'unknown'
    if (state.activeState === 'active' && state.mainPid !== rec.supervisor.pid) return 'unknown'
    const signal = this.deps.signalSupervisor ?? signalPid
    switch (signal(rec.supervisor.pid, rec.supervisor.start, 'SIGINT')) {
      case 'signalled':
        return 'signalled'
      case 'mismatch':
        return 'gone'
      default:
        return 'unknown'
    }
  }

  /**
   * Ended proof (§6): the RECORDED cgroup is absent or empty, no job is pending, identity checks pass; a changed boot
   * means ended; a cold-restarted manager with the unit gone is decided by the receipts and the recorded cgroup. Where
   * the sources of the record disagree, or systemd names another invocation or control group than the recorded one,
   * nothing is proven. The manager incarnation is re-read on every pass (review 2026-10-12 #6).
   */
  async proveEnded(
    launchId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ proven: boolean; proof: string | null; detail: string }> {
    const deadline = this.clock() + (options.timeoutMs ?? this.deps.proofTimeoutMs ?? 30_000)
    const population = this.deps.population ?? ((cg: string) => cgroupPopulation(cg))
    let detail: string
    for (;;) {
      const rec = this.recorded(launchId)
      const unit = rec.unit
      if (!rec.known || !unit)
        return { proven: false, proof: null, detail: 'no record of the unit' }
      if (rec.disagreement)
        return {
          proven: false,
          proof: null,
          detail: `the recorded identity disagrees (${rec.disagreement})`,
        }
      const bootHere = this.bootNow()
      if (rec.boot && bootHere !== null && rec.boot !== bootHere)
        return { proven: true, proof: 'boot-change', detail: 'the machine restarted' }
      const replaced = await this.incarnationChanged(rec)
      const shown = await showUnit(this.run, unit)
      if (shown.kind === 'unknown') detail = `systemd can’t be read (${shown.detail})`
      else if (shown.kind === 'absent') {
        const cgroup = rec.cgroup
        const pop = cgroup ? population(cgroup) : 'absent'
        if (pop === 'absent' || pop === 'empty') {
          return {
            proven: true,
            proof: cgroup ? 'cgroup-gone' : 'never-started',
            detail: 'unit gone',
          }
        }
        detail = `the unit is gone but its cgroup is ${pop}`
        // A different manager incarnation with the unit missing: the outcome comes from the receipts and the recorded
        // cgroup only, never from the missing metadata (§5). The supervisor writes `ended` only once its payload was
        // empty and nothing else of the unit lived, so the receipt is a witness the new manager cannot erase.
        if (pop === 'unknown' && replaced && this.readReceiptIn(rec, 'ended.json') === 'present')
          return {
            proven: true,
            proof: 'receipt',
            detail: 'ended receipt, manager replaced, unit gone',
          }
      } else {
        const s = shown.state
        if (rec.invocationId && s.invocationId !== rec.invocationId)
          return {
            proven: false,
            proof: null,
            detail: 'the unit’s invocation differs from the recorded one',
          }
        if (rec.cgroup && s.controlGroup && s.controlGroup !== rec.cgroup)
          return {
            proven: false,
            proof: null,
            detail: 'the unit’s control group differs from the recorded one',
          }
        if (!s.jobPending && (s.activeState === 'inactive' || s.activeState === 'failed')) {
          // The recorded cgroup is what must be empty; the one systemd names now is only a fallback for a launch that
          // never recorded one.
          const cg = rec.cgroup ?? s.controlGroup
          const pop = cg ? population(cg) : 'absent'
          if (pop === 'absent' || pop === 'empty')
            return { proven: true, proof: 'cgroup-empty', detail: 'unit inactive, cgroup empty' }
          detail = `the unit is ${s.activeState} but its cgroup is ${pop}`
        } else detail = `the unit is ${s.activeState}`
      }
      if (this.clock() >= deadline) return { proven: false, proof: null, detail }
      await sleep(this.deps.pollMs ?? 100)
    }
  }

  /** The user manager is not the one that verified this launch (a different PID or start time, or unreadable now). */
  private async incarnationChanged(rec: RecordedLaunch): Promise<boolean> {
    // Only a manager identity read now AND recorded before can differ; an unreadable one is uncertain, never a change.
    if (!rec.manager) return false
    const now = await this.managerNow()
    return now !== null && `${now.pid}:${now.start}` !== rec.manager
  }

  /** The manager is positively the one recorded when the launch was verified (unreadable or unrecorded is not). */
  private async managerUnchanged(launchId: string): Promise<boolean> {
    const rec = this.recorded(launchId)
    if (!rec.manager) return false
    const now = await this.managerNow()
    return now !== null && `${now.pid}:${now.start}` === rec.manager
  }

  /** The final receipt: absent/invalid, or valid. Evidence of the ACK only, never of how the supervisor exited. */
  private ackedReceipt(rec: RecordedLaunch): 'missing' | 'present' {
    return this.readReceiptIn(rec, 'acked.json') === 'present' ? 'present' : 'missing'
  }

  private readReceiptIn(rec: RecordedLaunch, name: 'released.json' | 'ended.json' | 'acked.json') {
    return this.readReceipt({ launch_id: rec.launchId, receipt_dir: rec.receiptDir } as Row, name)
  }

  /**
   * A receipt is proof only when it is complete JSON, an object of the expected kind, for this launch and generation.
   * Empty, partial, malformed or foreign input is `invalid`, never proof (review #8, reader side).
   */
  private readReceipt(
    row: Row,
    name: 'released.json' | 'ended.json' | 'acked.json',
  ): 'present' | 'absent' | 'invalid' | 'error' {
    if (!row.receipt_dir) return 'absent'
    let text: string
    try {
      text = readFileSync(join(row.receipt_dir, name), 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'error'
    }
    const generation = this.deps.journal.state(row.launch_id)?.state.generation
    return validReceipt(
      text,
      name === 'ended.json' ? 'ended' : name === 'acked.json' ? 'acked' : 'released',
      row.launch_id,
      generation,
    )
      ? 'present'
      : 'invalid'
  }

  /**
   * What systemd says about the recorded supervisor's exit, once the run ended and was proven: 'clean' only when the unit
   * is gone (a unit whose main process exited 0 is collected at once; a failed one stays and is read here) or still names
   * THIS supervisor (pid) with an ordinary exit and status 0. A supervisor that left because the socket or its ack was lost
   * exits non-zero, so a lost acknowledgment can't pass for a normal end (review 2026-10-12 #10).
   */
  private async supervisorExit(launchId: string): Promise<string> {
    const rec = this.recorded(launchId)
    if (!rec.unit || !rec.supervisor) return 'unrecorded'
    const shown = await showUnit(this.run, rec.unit)
    // A unit that exited 0 is collected at once, and a replaced manager forgets failures too: absence is no account of the
    // exit. The caller decides with the supervisor's own final receipt (`acked.json`).
    if (shown.kind === 'absent') return 'absent'
    if (shown.kind !== 'present') return 'unreadable'
    const state = shown.state
    if (rec.invocationId && state.invocationId !== rec.invocationId) return 'other-invocation'
    if (state.activeState === 'active' || state.jobPending) return 'running'
    if (state.execMainPid !== rec.supervisor.pid) return 'other-process'
    if (state.execMainCode !== 1 || state.execMainStatus !== 0 || state.result !== 'success')
      return `status-${state.execMainStatus ?? 'unknown'}`
    return 'clean'
  }

  /** After the session: record `released-seen`/`ended` in the journal (when proven) or hold the launch (when not). */
  private async proveAndEnd(
    launchId: string,
    request: { agentId: string; runtime: string },
    receiptDir: string,
    specDir: string,
    extra: { stopCause: string | null },
  ): Promise<{ proven: boolean; proof: string | null }> {
    const proof = await this.proveEnded(launchId)
    if (proof.proven) this.adoptStopReceipt(launchId)
    const project = this.projection(request, receiptDir, specDir, {
      // The journal's first cause (possibly just adopted from the supervisor's receipt) wins over this session's view.
      stop_cause: this.deps.journal.state(launchId)?.state.stopCause ?? extra.stopCause,
      held: proof.proven ? 0 : 1,
    })(launchId)
    try {
      const state = this.deps.journal.state(launchId)
      if (proof.proven) {
        if (
          state?.state.mayHaveExecuted &&
          state.kind === 'releasing' &&
          this.readReceipt(
            { launch_id: launchId, receipt_dir: receiptDir } as Row,
            'released.json',
          ) === 'present'
        )
          this.deps.journal.releasedSeen(launchId, {}, project)
        const ended = this.deps.journal.ended(
          launchId,
          { proof: proof.proof ?? 'unknown' },
          project,
        )
        if (!ended.ok && ended.reason !== 'illegal_transition')
          this.deps.onError?.(new Error(`ended refused: ${ended.reason}`))
      } else this.markHeld(launchId, 1)
    } catch (error) {
      this.deps.onError?.(error)
      return { proven: false, proof: null }
    }
    return { proven: proof.proven, proof: proof.proof }
  }

  private removeSpecDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // the directory is 0700 in the runtime dir; a leftover is harmless without the token's spec
    }
  }

  /** Launch reservations kept past the socket outcome, by run. */
  private readonly reservations = new Map<string, string[]>()

  private releaseReservations(runId: string): void {
    for (const launchId of this.reservations.get(runId) ?? [])
      this.socket.releaseReservation(launchId)
    this.reservations.delete(runId)
  }

  /**
   * The run's result is waiting to be saved (FW #8): its bytes are charged to the installation budget in place of the
   * launch reservation, until `releaseDelivery`. Called with everything the caller still retains for the run.
   */
  holdDelivery(runId: string, bytes: number): void {
    this.socket.hold(`delivery:${runId}`, bytes)
    this.releaseReservations(runId)
  }

  releaseDelivery(runId: string): void {
    this.socket.unhold(`delivery:${runId}`)
    this.releaseReservations(runId)
  }

  /** Bytes the installation budget currently charges (tests, diagnostics). */
  get budgetBytes(): number {
    return this.socket.bufferedBytes
  }

  markHeld(launchId: string, value: 0 | 1 | 2): void {
    this.deps.db.sqlite
      .prepare('UPDATE coding_launches SET held = ? WHERE launch_id = ?')
      .run(value, launchId)
  }

  /** The driver verdict on the result, kept beside the launch (design §2 "eligibility"). */
  noteEligibility(launchId: string, text: string): void {
    this.deps.db.sqlite
      .prepare('UPDATE coding_launches SET eligibility = ? WHERE launch_id = ?')
      .run(redactNote(text, 400), launchId)
  }

  // ---- settlement and collection (§6b) ------------------------------------------------------------------------------

  /**
   * After the run's terminal result committed: `settled`, then collection (`reset-failed` through the exact-name,
   * InvocationID-gated path). Only a launch whose end is proven and whose run is terminal is touched. Returns the
   * number of launches settled.
   */
  async settleRun(runId: string, disposition = 'committed'): Promise<number> {
    const run = this.deps.db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as
      { status: string } | undefined
    if (!run || ['queued', 'running', 'waiting_for_approval'].includes(run.status)) return 0
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT * FROM coding_launches WHERE run_id = ? AND backend = 'unit' AND phase = 'ended'",
      )
      .all(runId) as unknown as Row[]
    let settled = 0
    for (const row of rows) {
      if (await this.settle(row, disposition)) settled++
    }
    return settled
  }

  /** A launch of a turn that went on to a second launch (a refused resume): settled as retried. */
  async settleLaunch(launchId: string, disposition: string): Promise<boolean> {
    const row = this.rowOf(launchId)
    return row && row.phase === 'ended' ? this.settle(row, disposition) : false
  }

  private async settle(row: Row, disposition: string): Promise<boolean> {
    // A launch that isn't this installation's (a copied witness) is evidence only: never settled, never reset.
    if (!this.owns(row.launch_id, row.unit)) return false
    const result = this.deps.journal.settled(
      row.launch_id,
      { disposition },
      codingProjection(this.deps.db, this.clock),
    )
    if (!result.ok) {
      this.deps.onError?.(new Error(`settle refused: ${result.reason}`))
      return false
    }
    const rec = this.recorded(row.launch_id)
    if (rec.unit && rec.invocationId && this.owns(row.launch_id, rec.unit)) {
      try {
        await resetUnit(this.run, rec.unit, rec.invocationId, this.prefix)
      } catch (error) {
        this.deps.onError?.(error)
      }
    }
    return true
  }

  // ---- unresolved launches ---------------------------------------------------------------------------------------

  /** Launches of an agent whose end was never proven: the agent takes no new turn while any is held. */
  held(agentId: string): { runId: string; launchId: string; unit: string; canRelease: boolean }[] {
    return (
      this.deps.db.sqlite
        .prepare(
          "SELECT run_id, launch_id, unit, held FROM coding_launches WHERE agent_id = ? AND backend = 'unit' AND held > 0 AND phase NOT IN ('ended','settled') ORDER BY updated_at",
        )
        .all(agentId) as { run_id: string; launch_id: string; unit: string; held: number }[]
    ).map((r) => ({
      runId: r.run_id,
      launchId: r.launch_id,
      unit: r.unit,
      canRelease: r.held === 2,
    }))
  }

  /**
   * The person's deliberate way out of a launch Score can’t observe: recorded as a waiver, nothing is signalled. The
   * waiver goes into the journal first and settles the launch there, so a restart never stops it again; only then do the
   * database projections change (review 2026-10-12 #8). A launch whose waiver can't be journaled stays held.
   */
  releaseHeld(
    agentId: string,
    by = 'the person',
  ): { launchId: string; runId: string; unit: string }[] {
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT * FROM coding_launches WHERE agent_id = ? AND backend = 'unit' AND held = 2 AND phase NOT IN ('ended','settled')",
      )
      .all(agentId) as unknown as Row[]
    const released: Row[] = []
    for (const row of rows) {
      if (!this.owns(row.launch_id, row.unit)) continue
      const waived = this.deps.journal.waive(
        row.launch_id,
        by,
        codingProjection(this.deps.db, this.clock, (sqlite) =>
          sqlite
            .prepare(
              "UPDATE coding_launches SET held = 0, waiver = 1, disposition = 'waived' WHERE launch_id = ?",
            )
            .run(row.launch_id),
        ),
      )
      if (!waived.ok) {
        this.deps.onError?.(new Error(`waiver not journaled: ${waived.reason}`))
        continue
      }
      // `waive` projected the settled launch; `held` is runtime state the projection doesn't own, so clear it here too.
      this.deps.db.sqlite
        .prepare(
          "UPDATE coding_launches SET held = 0, waiver = 1, disposition = 'waived', phase = 'settled' WHERE launch_id = ?",
        )
        .run(row.launch_id)
      released.push(row)
    }
    return released.map((r) => ({ launchId: r.launch_id, runId: r.run_id, unit: r.unit ?? '' }))
  }

  /**
   * Stops an unresolved launch until it is proven ended (bounded backoff, one loop per launch). Resolves true once
   * proven. A launch whose unit can’t be read stays held and becomes releasable by the person.
   */
  reap(launchId: string, retryMs = 2000): Promise<boolean> {
    const known = this.reapers.get(launchId)
    if (known) return known
    const loop = (async () => {
      let delay = retryMs
      for (let first = true; !this.closed; first = false) {
        if (!first) {
          await sleep(delay)
          delay = Math.min(delay * 2, 60_000)
        }
        const row = this.rowOf(launchId)
        if (!row) return true
        if (row.phase === 'ended' || row.phase === 'settled') return true
        const stop = await this.stopSupervisor(launchId)
        const proof = await this.proveEnded(launchId, { timeoutMs: 5000 })
        if (proof.proven) {
          this.endRecord(row, proof.proof ?? 'unknown')
          this.markHeld(launchId, 0)
          await this.settleRun(row.run_id, 'interrupted')
          return true
        }
        this.markHeld(
          launchId,
          stop === 'unknown' || /can’t be read|differs|disagrees/.test(proof.detail) ? 2 : 1,
        )
      }
      return false
    })()
      .catch((error: unknown) => {
        this.deps.onError?.(error)
        return false
      })
      .finally(() => this.reapers.delete(launchId))
    this.reapers.set(launchId, loop)
    return loop
  }

  private endRecord(row: Row, proof: string): void {
    this.adoptStopReceipt(row.launch_id)
    const project = codingProjection(this.deps.db, this.clock)
    const state = this.deps.journal.state(row.launch_id)
    if (
      state?.kind === 'releasing' &&
      row.receipt_dir &&
      this.readReceipt(row, 'released.json') === 'present'
    )
      this.deps.journal.releasedSeen(row.launch_id, {}, project)
    // A launch that never executed is revoked before it ends: the journal alone proves no-launch (§3).
    if (state && !state.state.mayHaveExecuted && !state.state.revoked) {
      const cause = state.state.stopCause
      this.deps.journal.revoke(
        row.launch_id,
        undefined,
        project,
        cause === undefined
          ? 'start_failed'
          : cause === 'deadline'
            ? 'deadline'
            : cause === 'score-shutdown' || cause === 'unit-stop'
              ? 'restart'
              : 'stop',
      )
    }
    const ended = this.deps.journal.ended(row.launch_id, { proof }, project)
    if (!ended.ok && ended.reason !== 'illegal_transition')
      this.deps.onError?.(new Error(`ended refused: ${ended.reason}`))
    // Proof is the executor's evidence (7.7b §7): an attempt it holds as unknown is settled as soon as this is recorded.
    else this.deps.onEnded?.(row.run_id)
  }

  /** The runtime stopped waiting for the run: the stop request for a launch that has no live handle (no `UnitRun`). */
  async stopUnattached(launchId: string, reason: StopReason = 'user'): Promise<boolean> {
    this.recordStop(launchId, reason)
    await this.stopSupervisor(launchId)
    const proof = await this.proveEnded(launchId, { timeoutMs: 5000 })
    const row = this.rowOf(launchId)
    if (!row) return true
    if (proof.proven) {
      if (row.phase !== 'ended' && row.phase !== 'settled')
        this.endRecord(row, proof.proof ?? 'unknown')
      this.markHeld(launchId, 0)
      return true
    }
    this.markHeld(launchId, 1)
    return false
  }

  /** Unsettled launches of one run (for a Stop that finds no live handle). */
  openLaunchesOf(runId: string, agentId?: string): string[] {
    return (
      this.deps.db.sqlite
        .prepare(
          "SELECT launch_id FROM coding_launches WHERE run_id = ? AND backend = 'unit' AND phase NOT IN ('ended','settled') AND (? IS NULL OR agent_id IS NULL OR agent_id = ?)",
        )
        .all(runId, agentId ?? null, agentId ?? null) as { launch_id: string }[]
    ).map((r) => r.launch_id)
  }

  // ---- recovery (§6b) -----------------------------------------------------------------------------------------------

  /**
   * Journal ↔ database ↔ live units ↔ receipts, before any admission. Every unsettled launch this installation owns
   * (its unit-name prefix and a journal launch that isn't a copied witness) is stopped through its recorded
   * supervisor and its end proven; launches copied from another installation are evidence only and never acted on; a launch that never reached `releasing` is revoked
   * (the journal proves no-launch); one that may have executed and can’t be proven is held. Units carrying this
   * installation's prefix that no journal launch owns are orphans: they fence admission and are never adopted.
   */
  async recover(): Promise<RecoveryReport> {
    if (this.deps.unresolved || this.deps.frozen?.() != null)
      return { launches: [], orphans: [], unreadable: null }
    const read = this.deps.journal.journal.readOwn()
    if (!read.ok)
      return {
        launches: [],
        orphans: [],
        unreadable: `the execution journal can’t be read (${read.reason})`,
      }
    const folded = foldCodingLaunches(read.entries)
    const withUnit = [...folded.values()].filter((l) => l.state.unit !== undefined)
    // Only this installation's own launches are acted on (review 2026-10-12 #2): the prefix alone is not enough, since
    // a copy keeps the source's unit names and InvocationIDs in its witnesses.
    const owned = withUnit.filter((l) => this.owns(l.state.launchId, l.state.unit))
    const inventory = await listInstallationUnits(this.run, this.prefix)
    // The phase, not the last record's kind: a waived launch's last record is `waived`, its phase `settled`.
    const open = owned.filter((l) => l.state.phase !== 'settled')
    if (inventory.kind === 'unknown' && open.length > 0) {
      for (const l of open) this.ensureRow(l)
      for (const l of open) this.markHeld(l.state.launchId, 1)
      return {
        launches: open.map((l) => this.report(l, false)),
        orphans: [],
        unreadable: `systemd can’t be read (${inventory.detail})`,
      }
    }
    const names = inventory.kind === 'ok' ? inventory.names : []
    const known = new Set(withUnit.map((l) => l.state.unit))
    this.orphans = names.filter((n) => !known.has(n))
    const launches: RecoveredLaunch[] = []
    for (const l of open) {
      this.ensureRow(l)
      launches.push(await this.recoverOne(l))
    }
    return { launches, orphans: [...this.orphans], unreadable: null }
  }

  private report(l: CodingLaunch, ended: boolean): RecoveredLaunch {
    return {
      launchId: l.state.launchId,
      runId: l.state.runId,
      agentId: this.rowOf(l.state.launchId)?.agent_id ?? null,
      ended,
      mayHaveExecuted: l.state.mayHaveExecuted,
    }
  }

  /** A launch the journal knows but the database lacks (an older backup): a minimal row, so routing exists. */
  private ensureRow(l: CodingLaunch): void {
    const id = l.state.launchId
    if (!this.rowOf(id)) {
      const project = codingProjection(this.deps.db, this.clock, (sqlite, state: CodingState) =>
        sqlite
          .prepare('UPDATE coding_launches SET receipt_dir = ? WHERE launch_id = ?')
          .run(join(this.deps.namespaceDir, LAUNCHES_DIR, state.launchId), state.launchId),
      )
      // Re-project the journal's own newest record.
      const entry = this.deps.journal.journal.readOwn()
      if (entry.ok) {
        const mine = entry.entries.findLast((e) => 'launchId' in e && e.launchId === id)
        if (mine) project(mine, l.state)
      }
    }
    // Routing a restored or rebuilt row lacks (the journal carries identity, not the agent): the run names its agent,
    // and a removed agent's launches keep their routing until settled (§6b). Where the run row is lost too, the routing
    // file beside the journal answers; with neither, the launch stays unattributed and fences all coding (`block`).
    const dir = join(this.deps.namespaceDir, LAUNCHES_DIR, id)
    const routing = this.readRouting(dir, id)
    this.deps.db.sqlite
      .prepare(
        `UPDATE coding_launches SET backend = COALESCE(backend, 'unit'),
           agent_id = COALESCE(agent_id, (SELECT profile FROM runs WHERE runs.id = coding_launches.run_id), ?),
           runtime = COALESCE(runtime, (SELECT runtime FROM runs WHERE runs.id = coding_launches.run_id), ?),
           receipt_dir = COALESCE(receipt_dir, ?)
         WHERE launch_id = ?`,
      )
      .run(routing?.agentId ?? null, routing?.runtime ?? null, dir, id)
  }

  private async recoverOne(l: CodingLaunch): Promise<RecoveredLaunch> {
    const id = l.state.launchId
    // No `releasing` record: the journal proves the CLI never ran. Revoke so nothing can release it later.
    if (!l.state.mayHaveExecuted && !l.state.revoked)
      this.deps.journal.revoke(id, undefined, codingProjection(this.deps.db, this.clock), 'restart')
    await this.stopSupervisor(id)
    const proof = await this.proveEnded(id, { timeoutMs: this.deps.recoverProofMs ?? 10_000 })
    const row = this.rowOf(id)
    if (proof.proven && row) {
      if (l.kind !== 'ended') this.endRecord(row, proof.proof ?? 'unknown')
      this.markHeld(id, 0)
      return this.report(l, true)
    }
    // May have executed and not proven: unconfirmed. The agent is held; a loop keeps stopping it.
    this.markHeld(id, 1)
    return this.report(l, false)
  }
}

class Control {
  stopReason: StopReason | null = null
  private session: RunSession | null = null
  private wake: () => void = () => undefined
  readonly stopped: Promise<void> = new Promise<void>((resolve) => {
    this.wake = resolve
  })

  constructor(private readonly launchId: string) {}

  attach(session: RunSession): void {
    this.session = session
  }

  requestStop(reason: StopReason, backend: UnitBackend): void {
    if (this.stopReason !== null) return
    this.stopReason = reason
    // Durable first, even before a session exists: the launch row may already be there.
    backend.recordStop(this.launchId, reason)
    this.wake()
    if (this.session) backend.sendStop(this.launchId, this.session, reason)
  }
}

/**
 * The CLI's stderr as it may be kept (review 2026-10-12 #4). Redaction needs the label in front of a value, so the
 * text is kept from its start (never a tail cut through a value) up to a raw limit, and it is redacted as a whole
 * whenever it is read. Past the limit the rest is dropped, not kept in a form redaction can't recognise.
 */

const UNIT_NOTE = 'Runs as a supervised system service.'
const FALLBACK_NOTE =
  'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them.'

/** One definition of a valid receipt, shared with the writer (supervisor.mjs `parseReceipt`, FX1). */
function validReceipt(
  text: string,
  kind: 'released' | 'ended' | 'acked',
  launchId: string,
  generation: number | undefined,
): boolean {
  if (generation === undefined) return false
  return parseReceipt(text, kind, { launch: launchId, generation }).state === 'present'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function procCgroup(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'))
    return line ? line.slice(3) : null
  } catch {
    return null
  }
}

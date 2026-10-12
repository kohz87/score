import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScoreDb } from '../../db/index.ts'
import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import type { CodingJournal } from '../../domain/orchestration/coding-journal.ts'
import {
  foldCodingLaunches,
  type CodingLaunch,
  type CodingState,
} from '../../domain/orchestration/coding-records.ts'
import { installation8, LAUNCHES_DIR } from '../../installation.ts'
import { mkdirDurable } from '../../locks/os-lock.ts'
import { CodingSocketServer, type RunSession } from './coding-socket.ts'
import { bootId, processStart } from './proc.ts'
import { pdeathsigSupport } from './pdeathsig-exec.ts'
import type { StopReason } from './process.ts'
import { hashSpec, type SupervisorSpec } from './supervisor.mjs'
import type { CodingEvent, LineParser } from './types.ts'
import {
  buildSystemRun,
  cgroupPopulation,
  checkCapabilities,
  listInstallationUnits,
  managerEnvironmentNames,
  managerIncarnation,
  realRunTool,
  resetUnit,
  showUnit,
  stopUnit,
  unitNameFor,
  unitPrefix,
  validateUnitName,
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
  run?: RunTool
  clock?: () => number
  onError?: (error: unknown) => void
  /** Test seams. */
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
  /** Processes one parsed event, strictly in order. A rejection makes the result ineligible and stops the run. */
  onEvent(event: CodingEvent): Promise<void>
  /** Wall-clock deadline of the whole turn (epoch ms), shared by every launch attempt. */
  deadline: number
  graceMs: number
  /** Re-evaluated inside the release critical section: not stopped, runtime open, agent not held. */
  authorised(): boolean
  /** The CLI was released (`go` sent). */
  onReleased?(launchId: string): void
}

export interface UnitOutcome {
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

const STOP_CAUSE: Record<StopReason, string> = {
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
      })
    this.current = {
      kind: 'process-group',
      checks: [],
      checkedAt: new Date(this.clock()).toISOString(),
      note: FALLBACK_NOTE,
    }
  }

  get status(): BackendStatus {
    return this.current
  }
  /** True when new coding runs should use the unit backend. */
  usable(): boolean {
    return this.current.kind === 'unit' && !this.closed
  }
  /** Why admission is paused, or null. */
  block(): string | null {
    if (this.orphans.length > 0)
      return 'A coding service from an earlier session isn’t accounted for. Score paused coding runs until you review it.'
    return this.deps.blocked?.() ?? null
  }
  get orphaned(): readonly string[] {
    return this.orphans
  }

  // ---- startup and capability ------------------------------------------------------------------------------------

  /** Starts the socket listener and runs the capability check. Never throws: a failure means the fallback backend. */
  async start(): Promise<BackendStatus> {
    try {
      // Held by the caller: the home lock keeps a second Score off this installation's socket (design §4).
      await this.socket.start(true)
    } catch (error) {
      this.socketError = error instanceof Error ? error.message : String(error)
    }
    return this.check()
  }

  /** "Check again": the same check, on demand. */
  async check(): Promise<BackendStatus> {
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
    this.current = {
      kind: all ? 'unit' : 'process-group',
      checks,
      checkedAt: new Date(this.clock()).toISOString(),
      note: all ? UNIT_NOTE : `${FALLBACK_NOTE} ${checks.find((c) => !c.ok)?.detail ?? ''}`.trim(),
    }
    return this.current
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
    const launchId = randomUUID()
    const ctl = new Control()
    const done = this.drive(launchId, request, ctl).catch((error: unknown) => {
      this.deps.onError?.(error)
      return this.outcomeOf(launchId, '', {
        refusal: `Could not start the supervised run: ${error instanceof Error ? error.message : String(error)}`,
        stats: request.parser.stats,
      })
    })
    return { launchId, stop: (reason = 'user') => ctl.requestStop(reason, this), done }
  }

  /** Called by `Control.requestStop` once a session exists and the CLI is released. */
  sendStop(launchId: string, session: RunSession | null, reason: StopReason): void {
    if (session?.connected) session.stop(STOP_CAUSE[reason])
    else void this.stopByName(launchId).catch((error: unknown) => this.deps.onError?.(error))
  }

  private outcomeOf(
    launchId: string,
    unit: string,
    over: Partial<UnitOutcome> & { stats: LineParser['stats'] },
  ): UnitOutcome {
    return {
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
          sets.push(`${column} = ?`)
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
    const refuse = (refusal: string) => this.outcomeOf(launchId, unit, { refusal, stats })
    if (this.tooFast())
      return refuse('Score is starting coding runs too quickly. Try again in a minute.')
    const blocked = this.block()
    if (blocked) return refuse(blocked)
    if (ctl.stopReason) return refuse('Stopped before it started.')

    // Per-launch directories before `requested`: the receipt directory outside the home (each parent fsynced), and the
    // spec directory in the runtime dir (0700). Nothing external has happened yet, so a failure is a plain refusal.
    try {
      mkdirDurable(receiptDir)
      mkdirSync(specDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      return refuse(`Couldn’t prepare the run’s folders: ${errorText(error)}`)
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
    const requested = journal.requestLaunch(identity, project(launchId), { unit })
    if (!requested.ok) {
      this.removeSpecDir(specDir)
      return refuse(`Couldn’t record the run (${requested.reason}).`)
    }

    // ---- from here the launch is journaled: every exit goes through `end()` ----
    let session: RunSession | null = null
    let unitState: UnitState | null = null
    let released = false
    let stderr = ''
    const finish = async (
      over: Partial<UnitOutcome> = {},
      stopCause: string | null = null,
    ): Promise<UnitOutcome> => {
      const proof = await this.proveAndEnd(launchId, request, receiptDir, specDir, {
        stopCause: ctl.stopReason ? STOP_CAUSE[ctl.stopReason] : stopCause,
      })
      this.removeSpecDir(specDir)
      return this.outcomeOf(launchId, unit, {
        released,
        stderr,
        stats,
        proven: proof.proven,
        proof: proof.proof,
        stopped: ctl.stopReason,
        ...over,
      })
    }
    const abort = async (reason: string): Promise<UnitOutcome> => {
      // Nothing was released. Revoke if the journal still allows it (no `releasing`), cancel/stop, then prove.
      const revoked = journal.revoke(launchId, undefined, project(launchId))
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
      await this.stopByName(launchId, unitState?.invocationId)
      return finish({ refusal: reason })
    }

    let sawEvents = false
    const handlers = {
      onStdoutRecord: async (line: string) => {
        const events = request.parser.parse(line)
        if (events.length) sawEvents = true
        for (const event of events) await request.onEvent(event)
      },
      onStderr: (text: string) => {
        stderr = (stderr + text).slice(-8 * 1024)
      },
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
    const registered = this.socket.expect({
      launch: launchId,
      generation: request.generation,
      specHash: hashSpec(spec),
      handlers,
    })
    session = registered.session
    spec.token = registered.token
    const specPath = join(specDir, 'spec.json')
    try {
      writeFileSync(specPath, JSON.stringify(spec), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      return abort(`Couldn’t write the run’s settings: ${errorText(error)}`)
    }
    if (ctl.stopReason) return abort('Stopped before it started.')

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
      const detail = started.stderr.trim().slice(0, 160)
      return abort(
        `The system service manager refused to start the run${detail ? ` (${detail})` : ''}.`,
      )
    }
    if (ctl.stopReason) return abort('Stopped before it started.')

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
      )
    const verified = await this.verifyIdentity(unit, ready.info)
    if (!verified.ok) return abort(`The run’s identity didn’t check out (${verified.reason}).`)
    unitState = verified.state
    const manager = await this.managerNow()
    const managerText = manager ? `${this.bootNow() ?? ''}|${manager.pid}:${manager.start}` : null
    const armed = journal.arm(
      launchId,
      { unit, invocationId: unitState.invocationId, cgroup: ready.info.cgroup },
      this.projection(request, receiptDir, specDir, { manager: managerText })(launchId),
    )
    if (!armed.ok) return abort(`Couldn’t record the run’s identity (${armed.reason}).`)
    // The spec held the single-use token: Score's backstop deletes it now that the supervisor reported in.
    this.removeSpecDir(specDir)
    if (ctl.stopReason) return abort('Stopped before it started.')

    // ---- the ordering point (§3) ----
    const releasing = journal.release(
      launchId,
      () => !ctl.stopReason && request.authorised(),
      project(launchId),
    )
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
        await this.stopByName(launchId, unitState.invocationId)
        return finish({ refusal: 'Couldn’t save the run’s start. Nothing was sent to the CLI.' })
      }
      return abort(
        releasing.reason === 'not_authorised'
          ? 'Stopped before it started.'
          : `Couldn’t release the run (${releasing.reason}).`,
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
        complete: outcome.kind === 'ended' && blocking.length === 0,
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

  private rowOf(launchId: string): Row | undefined {
    return this.deps.db.sqlite
      .prepare('SELECT * FROM coding_launches WHERE launch_id = ?')
      .get(launchId) as Row | undefined
  }

  /** `systemctl --user stop <exact name>`, gated on the InvocationID (the recorded one, else the one systemd shows). */
  async stopByName(
    launchId: string,
    invocationId?: string,
  ): Promise<'stopped' | 'absent' | 'unknown' | 'other'> {
    const row = this.rowOf(launchId)
    const unit = row?.unit
    if (!unit || !validateUnitName(unit)) return 'unknown'
    let invocation = invocationId ?? row.invocation_id ?? ''
    if (invocation === '') {
      // The launch never armed: the name is unique to this launch, so the invocation systemd shows now is its own.
      const shown = await showUnit(this.run, unit)
      if (shown.kind === 'absent') return 'absent'
      if (shown.kind === 'unknown') return 'unknown'
      invocation = shown.state.invocationId
    }
    const result = await stopUnit(this.run, unit, invocation)
    if (result === 'stopped') return 'stopped'
    if (result === 'absent') return 'absent'
    return result === 'unknown' ? 'unknown' : 'other'
  }

  /**
   * Ended proof (§6): the recorded cgroup is absent or empty, no job is pending, identity checks pass; a changed boot
   * means ended; a cold-restarted manager with the unit gone is decided by the receipts and the recorded cgroup.
   */
  async proveEnded(
    launchId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ proven: boolean; proof: string | null; detail: string }> {
    const deadline = this.clock() + (options.timeoutMs ?? this.deps.proofTimeoutMs ?? 30_000)
    const population = this.deps.population ?? ((cg: string) => cgroupPopulation(cg))
    let detail: string
    for (;;) {
      const row = this.rowOf(launchId)
      const unit = row?.unit ?? null
      if (!row || !unit) return { proven: false, proof: null, detail: 'no record of the unit' }
      const bootThen = row.manager?.split('|')[0] ?? ''
      const bootHere = this.bootNow()
      if (bootThen !== '' && bootHere !== null && bootThen !== bootHere)
        return { proven: true, proof: 'boot-change', detail: 'the machine restarted' }
      const shown = await showUnit(this.run, unit)
      if (shown.kind === 'unknown') detail = `systemd can’t be read (${shown.detail})`
      else if (shown.kind === 'absent') {
        const cgroup = row.cgroup
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
        if (
          pop === 'unknown' &&
          (await this.incarnationChanged(row)) &&
          this.readReceipt(row, 'ended.json') === 'present'
        )
          return {
            proven: true,
            proof: 'receipt',
            detail: 'ended receipt, manager replaced, unit gone',
          }
      } else {
        const s = shown.state
        if (row.invocation_id && s.invocationId !== row.invocation_id)
          return {
            proven: false,
            proof: null,
            detail: 'the unit’s invocation differs from the recorded one',
          }
        if (!s.jobPending && (s.activeState === 'inactive' || s.activeState === 'failed')) {
          const cg = s.controlGroup || row.cgroup || ''
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
  private async incarnationChanged(row: Row): Promise<boolean> {
    const recorded = row.manager?.split('|')[1]
    if (!recorded) return true
    const now = await this.managerNow()
    return now === null || `${now.pid}:${now.start}` !== recorded
  }

  private readReceipt(row: Row, name: string): 'present' | 'absent' | 'error' {
    if (!row.receipt_dir) return 'absent'
    try {
      readFileSync(join(row.receipt_dir, name), 'utf8')
      return 'present'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'error'
    }
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
    const project = this.projection(request, receiptDir, specDir, {
      stop_cause: extra.stopCause,
      held: proof.proven ? 0 : 1,
    })(launchId)
    try {
      const state = this.deps.journal.state(launchId)
      if (proof.proven) {
        if (
          state?.state.mayHaveExecuted &&
          state.kind === 'releasing' &&
          this.hasReceipt(receiptDir, 'released.json')
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

  private hasReceipt(dir: string, name: string): boolean {
    return existsSync(join(dir, name))
  }

  private removeSpecDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // the directory is 0700 in the runtime dir; a leftover is harmless without the token's spec
    }
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
      .run(text.slice(0, 400), launchId)
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
    const result = this.deps.journal.settled(
      row.launch_id,
      { disposition },
      codingProjection(this.deps.db, this.clock),
    )
    if (!result.ok) {
      this.deps.onError?.(new Error(`settle refused: ${result.reason}`))
      return false
    }
    if (row.unit && row.invocation_id) {
      try {
        await resetUnit(this.run, row.unit, row.invocation_id)
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

  /** The person's deliberate way out of a launch Score can’t observe: recorded as a waiver, nothing is signalled. */
  releaseHeld(agentId: string): { launchId: string; runId: string; unit: string }[] {
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT * FROM coding_launches WHERE agent_id = ? AND backend = 'unit' AND held = 2 AND phase NOT IN ('ended','settled')",
      )
      .all(agentId) as unknown as Row[]
    for (const row of rows) {
      const project = codingProjection(this.deps.db, this.clock, (sqlite) =>
        sqlite
          .prepare('UPDATE coding_launches SET held = 0 WHERE launch_id = ?')
          .run(row.launch_id),
      )
      this.deps.journal.ended(row.launch_id, { proof: 'waiver', waiver: true }, project)
    }
    return rows.map((r) => ({ launchId: r.launch_id, runId: r.run_id, unit: r.unit ?? '' }))
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
        const stop = await this.stopByName(launchId)
        const proof = await this.proveEnded(launchId, { timeoutMs: 5000 })
        if (proof.proven) {
          this.endRecord(row, proof.proof ?? 'unknown')
          this.markHeld(launchId, 0)
          await this.settleRun(row.run_id, 'interrupted')
          return true
        }
        this.markHeld(
          launchId,
          stop === 'unknown' || /can’t be read|differs/.test(proof.detail) ? 2 : 1,
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
    const project = codingProjection(this.deps.db, this.clock)
    const state = this.deps.journal.state(row.launch_id)
    if (
      state?.kind === 'releasing' &&
      row.receipt_dir &&
      this.hasReceipt(row.receipt_dir, 'released.json')
    )
      this.deps.journal.releasedSeen(row.launch_id, {}, project)
    // A launch that never executed is revoked before it ends: the journal alone proves no-launch (§3).
    if (state && !state.state.mayHaveExecuted && !state.state.revoked)
      this.deps.journal.revoke(row.launch_id, undefined, project)
    const ended = this.deps.journal.ended(row.launch_id, { proof }, project)
    if (!ended.ok && ended.reason !== 'illegal_transition')
      this.deps.onError?.(new Error(`ended refused: ${ended.reason}`))
  }

  /** The runtime stopped waiting for the run: the stop request for a launch that has no live handle (no `UnitRun`). */
  async stopUnattached(launchId: string): Promise<boolean> {
    await this.stopByName(launchId)
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
  openLaunchesOf(runId: string): string[] {
    return (
      this.deps.db.sqlite
        .prepare(
          "SELECT launch_id FROM coding_launches WHERE run_id = ? AND backend = 'unit' AND phase NOT IN ('ended','settled')",
        )
        .all(runId) as { launch_id: string }[]
    ).map((r) => r.launch_id)
  }

  // ---- recovery (§6b) -----------------------------------------------------------------------------------------------

  /**
   * Journal ↔ database ↔ live units ↔ receipts, before any admission. Every unsettled launch of this installation is
   * stopped (by exact name, InvocationID-gated) and its end proven; a launch that never reached `releasing` is revoked
   * (the journal proves no-launch); one that may have executed and can’t be proven is held. Units carrying this
   * installation's prefix that no journal launch owns are orphans: they fence admission and are never adopted.
   */
  async recover(): Promise<RecoveryReport> {
    const read = this.deps.journal.journal.readOwn()
    if (!read.ok)
      return {
        launches: [],
        orphans: [],
        unreadable: `the execution journal can’t be read (${read.reason})`,
      }
    const folded = foldCodingLaunches(read.entries)
    const owned = [...folded.values()].filter((l) => l.state.unit !== undefined)
    const inventory = await listInstallationUnits(this.run, this.prefix)
    const open = owned.filter((l) => l.kind !== 'settled')
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
    const known = new Set(owned.map((l) => l.state.unit))
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
    if (this.rowOf(l.state.launchId)) return
    const project = codingProjection(this.deps.db, this.clock, (sqlite, state: CodingState) =>
      sqlite
        .prepare("UPDATE coding_launches SET backend = 'unit', receipt_dir = ? WHERE launch_id = ?")
        .run(join(this.deps.namespaceDir, LAUNCHES_DIR, state.launchId), state.launchId),
    )
    // Re-project the journal's own newest record.
    const entry = this.deps.journal.journal.readOwn()
    if (entry.ok) {
      const mine = entry.entries.findLast((e) => 'launchId' in e && e.launchId === l.state.launchId)
      if (mine) project(mine, l.state)
    }
  }

  private async recoverOne(l: CodingLaunch): Promise<RecoveredLaunch> {
    const id = l.state.launchId
    // No `releasing` record: the journal proves the CLI never ran. Revoke so nothing can release it later.
    if (!l.state.mayHaveExecuted && !l.state.revoked)
      this.deps.journal.revoke(id, undefined, codingProjection(this.deps.db, this.clock))
    await this.stopByName(id, l.state.invocationId)
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
  private launchId = ''

  attach(session: RunSession): void {
    this.session = session
    this.launchId = session.launch
  }

  requestStop(reason: StopReason, backend: UnitBackend): void {
    if (this.stopReason !== null) return
    this.stopReason = reason
    this.wake()
    if (this.session) backend.sendStop(this.launchId, this.session, reason)
  }
}

const UNIT_NOTE = 'Runs as a supervised system service.'
const FALLBACK_NOTE =
  'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them.'

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

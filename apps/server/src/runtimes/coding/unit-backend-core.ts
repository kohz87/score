import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import { foldCodingLaunches, type CodingState } from '../../domain/orchestration/coding-records.ts'
import { LAUNCHES_DIR } from '../../installation.ts'
import { CodingSocketServer } from './coding-socket.ts'
import { redactNote } from './note.ts'
import {
  EXTRA_COLUMNS,
  FALLBACK_NOTE,
  IDENTITY_FILE,
  IdentityFile,
  LAUNCHES_PER_MINUTE,
  ROUTING_FILE,
  RoutingFile,
  UNIT_CAPABLE_FILE,
  type Extra,
  type RecordedLaunch,
  type Row,
} from './unit-backend-helpers.ts'
import type { BackendStatus, UnitBackendDeps, UnitOutcome } from './unit-backend-types.ts'
import type { LineParser } from './types.ts'
import { hasInstallationPrefix, realRunTool, unitPrefix, type RunTool } from './units.ts'

export class UnitBackendCore {
  readonly socket: CodingSocketServer
  protected readonly run: RunTool
  protected readonly clock: () => number
  protected readonly prefix: string
  protected readonly starts: number[] = []
  protected current: BackendStatus
  protected socketError: string | null = null
  /** The installation has passed the unit check at least once (the marker file). */
  protected capable = false
  /** Why runs are paused: the unit check failed on an installation that passed it before. */
  protected paused: string | null = null
  /** The pass is known but its marker file isn't durable yet: no unit launch until it is (decision 70). */
  protected markerPending = false
  /** Launches whose stop cause couldn't be made durable: their result can't be eligible. */
  protected readonly unrecordedStops = new Set<string>()
  protected closed = false
  protected orphans: string[] = []
  protected readonly reapers = new Map<string, Promise<boolean>>()

  /** Launch reservations kept past the socket outcome, by run. */
  protected readonly reservations = new Map<string, string[]>()

  constructor(protected readonly deps: UnitBackendDeps) {
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
  protected historyShowsUnits(): boolean {
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

  protected outcomeOf(
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

  protected projection(
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

  protected tooFast(): boolean {
    const now = this.clock()
    while (this.starts.length > 0 && now - this.starts[0]! > 60_000) this.starts.shift()
    if (this.starts.length >= (this.deps.launchesPerMinute ?? LAUNCHES_PER_MINUTE)) return true
    this.starts.push(now)
    return false
  }

  protected storedStopCause(launchId: string): string | null {
    const found = this.deps.db.sqlite
      .prepare('SELECT stop_cause FROM coding_launches WHERE launch_id = ?')
      .get(launchId) as { stop_cause: string | null } | undefined
    return found?.stop_cause ?? null
  }

  protected rowOf(launchId: string): Row | undefined {
    return this.deps.db.sqlite
      .prepare('SELECT * FROM coding_launches WHERE launch_id = ?')
      .get(launchId) as Row | undefined
  }

  /** Ownership at every stop/reset boundary: this installation's unit-name prefix AND a launch the journal says is ours. */
  protected owns(launchId: string, unit: string | null | undefined): boolean {
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
  protected recorded(launchId: string): RecordedLaunch {
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

  protected readRouting(dir: string, launchId: string) {
    try {
      const file = RoutingFile.parse(JSON.parse(readFileSync(join(dir, ROUTING_FILE), 'utf8')))
      return file.launch === launchId ? file : undefined
    } catch {
      return undefined
    }
  }

  protected readIdentity(dir: string, launchId: string, generation: number | undefined) {
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

  protected removeSpecDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // the directory is 0700 in the runtime dir; a leftover is harmless without the token's spec
    }
  }

  protected releaseReservations(runId: string): void {
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
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import type { RunSession } from './coding-socket.ts'
import { signalPid } from './pidfd-signal.ts'
import { bootId, processStart } from './proc.ts'
import type { StopReason } from './process.ts'
import { UnitBackendCapability } from './unit-backend-capability.ts'
import {
  STOP_CAUSE,
  STOP_RECEIPT,
  procCgroup,
  sleep,
  validReceipt,
  type RecordedLaunch,
  type Row,
} from './unit-backend-helpers.ts'
import {
  cgroupPopulation,
  managerIncarnation,
  showUnit,
  type ManagerIncarnation,
  type UnitState,
} from './units.ts'

export class UnitBackendProof extends UnitBackendCapability {
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
  protected adoptStopReceipt(launchId: string): void {
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
  protected stopReceiptProblem(launchId: string, error: unknown): void {
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

  // ---- identity ----------------------------------------------------------------------------------------------------

  protected async verifyIdentity(
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

  protected managerNow(): Promise<ManagerIncarnation | null> {
    return this.deps.manager ? this.deps.manager() : managerIncarnation(this.run)
  }
  protected bootNow(): string | null {
    return (this.deps.proc?.boot ?? bootId)()
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
  protected async incarnationChanged(rec: RecordedLaunch): Promise<boolean> {
    // Only a manager identity read now AND recorded before can differ; an unreadable one is uncertain, never a change.
    if (!rec.manager) return false
    const now = await this.managerNow()
    return now !== null && `${now.pid}:${now.start}` !== rec.manager
  }

  /** The manager is positively the one recorded when the launch was verified (unreadable or unrecorded is not). */
  protected async managerUnchanged(launchId: string): Promise<boolean> {
    const rec = this.recorded(launchId)
    if (!rec.manager) return false
    const now = await this.managerNow()
    return now !== null && `${now.pid}:${now.start}` === rec.manager
  }

  /** The final receipt: absent/invalid, or valid. Evidence of the ACK only, never of how the supervisor exited. */
  protected ackedReceipt(rec: RecordedLaunch): 'missing' | 'present' {
    return this.readReceiptIn(rec, 'acked.json') === 'present' ? 'present' : 'missing'
  }

  protected readReceiptIn(
    rec: RecordedLaunch,
    name: 'released.json' | 'ended.json' | 'acked.json',
  ) {
    return this.readReceipt({ launch_id: rec.launchId, receipt_dir: rec.receiptDir } as Row, name)
  }

  /**
   * A receipt is proof only when it is complete JSON, an object of the expected kind, for this launch and generation.
   * Empty, partial, malformed or foreign input is `invalid`, never proof (review #8, reader side).
   */
  protected readReceipt(
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
  protected async supervisorExit(launchId: string): Promise<string> {
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
  protected async proveAndEnd(
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
}

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installation8, LAUNCHES_DIR } from '../../installation.ts'
import { mkdirDurable } from '../../locks/os-lock.ts'
import { RETAINED_RUN_BYTES, type CodingSocketServer, type RunSession } from './coding-socket.ts'
import type { ReleaseDecision } from '../../domain/orchestration/coding-journal.ts'
import type { OwnedLaunchJournal } from '../../domain/orchestration/owner.ts'
import { BoundedDiagnostics, redactNote } from './note.ts'
import { pdeathsigSupport } from './pdeathsig-exec.ts'
import { hashSpec, writeReceipt, type SupervisorSpec } from './supervisor.mjs'
import { UnitBackendProof } from './unit-backend-proof.ts'
import {
  Control,
  IDENTITY_FILE,
  ROUTING_FILE,
  STOP_CAUSE,
  errorText,
  reasonOfCause,
  sleep,
} from './unit-backend-helpers.ts'
import type { UnitLaunchRequest, UnitOutcome } from './unit-backend-types.ts'
import { buildSystemRun, managerEnvironmentNames, unitNameFor } from './units.ts'

const SUPERVISOR_FILE = fileURLToPath(new URL('./supervisor.mjs', import.meta.url))
const WRAPPER_FILE = fileURLToPath(new URL('./pdeathsig-exec.py', import.meta.url))

export class UnitBackendDrive extends UnitBackendProof {
  protected async drive(
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
    if (blocked) return refuse(blocked, this.deps.frozen?.() != null ? 'frozen' : 'fenced')
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
    const decide = (tx: OwnedLaunchJournal): ReleaseDecision => {
      if (ctl.stopReason) return { allowed: false, cause: 'stop' }
      if (this.deps.frozen?.() != null) return { allowed: false, cause: 'frozen' }
      if (this.block() !== null) return { allowed: false, cause: 'fenced' }
      if (!request.authorised()) return { allowed: false, cause: 'stop' }
      return (
        request.authorise?.(
          {
            expiry: request.deadline,
            ...(request.preparedPolicyId === undefined
              ? {}
              : { policyId: request.preparedPolicyId }),
          },
          tx,
        ) ?? { allowed: true }
      )
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
}

import { subagentDriverOptions } from '../../domain/subagents.ts'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { driverFor } from './drivers.ts'
import { blockHash, frameOf, promptWithInstructions } from './instructions.ts'
import { CappedText } from './note.ts'
import { checkRoot } from '../../workspace/policy.ts'
import { redact } from '../../redact.ts'
import { CodingRuntimeLaunch } from './service-launch.ts'
import {
  refusesResume,
  oneLine,
  TERMINAL_NOTE,
  UNRESOLVED_NOTE,
  type ActiveRun,
} from './service-types.ts'
import {
  cliSessionFor,
  cliSessionInstructions,
  forgetCliSession,
  getCodingAgent,
  rememberCliInstructions,
  type StoredCodingAgent,
} from './store.ts'
import {
  eventObservation,
  newTranslation,
  runningObservation,
  translationBytes,
  type TerminalInfo,
} from './translate.ts'
import type { CodingEvent } from './types.ts'
import type { StopReason } from './process.ts'

export class CodingRuntimeExecution extends CodingRuntimeLaunch {
  protected async executeRun(
    temporary: string[],
    entry: ActiveRun,
    admitted: StoredCodingAgent,
    input: string,
    job: string | null,
    /** The model admitted with the turn (`req.model ?? agent.model` at admission): what the row says is what runs. */
    model: string | null,
  ): Promise<void> {
    const { db, ingest, locator } = this.deps
    // A queued turn starts long after admission: permission, workspace and the rest are read as they are now.
    const agent = getCodingAgent(db.sqlite, admitted.id)
    if (!agent)
      return void (await this.finish(newTranslation(entry.runId, admitted.id, job), {
        status: 'failed',
        error: 'This coding agent was removed',
        costKind: 'unknown',
      }))
    const driver = driverFor(agent.runtime)
    const translation = newTranslation(entry.runId, agent.id, job, Boolean(entry.owner))
    translation.subagentJobId = job ?? entry.jobId ?? null
    const costKind = agent.runtime === 'claude-code' ? 'estimated' : 'unknown'
    const owner = entry.owner
    // An owned worker runs what its policy says (7.7b §3), never what the agent row says now: permission, model and
    // workspace come from the policy the person approved; a row changed to `full` and back changes nothing here.
    const frozenPolicy = owner?.policy
    if (frozenPolicy) {
      agent.permission = frozenPolicy.policy.permission
      agent.workspace = frozenPolicy.policy.workspace.real
      model = frozenPolicy.policy.model
    } else {
      // The room's shared workspace for this agent (3.20.0), read now: the room may have changed since admission. From here
      // on `agent.workspace` is the one folder: the root check below, `checked.real` for the spawn, the parser and the args.
      agent.workspace = this.workspaceFor(agent, this.roomOf(entry.turnId))
    }
    // Ends the run without a launch having been requested. An owned run leaves the reason class for its executor.
    const endUnlaunched = async (cause: string, info: TerminalInfo): Promise<void> => {
      if (owner) this.recordRefusal(entry.runId, cause, info.error ?? null)
      await this.finish(translation, owner ? { ...info, ownedResult: true } : info)
    }
    const stopCause = (reason: StopReason): string =>
      reason === 'shutdown' ? 'restart' : reason === 'timeout' ? 'deadline' : 'stop'
    const stopped = (reason: StopReason): TerminalInfo => ({
      status: reason === 'shutdown' ? 'interrupted' : reason === 'user' ? 'cancelled' : 'failed',
      error:
        reason === 'shutdown'
          ? TERMINAL_NOTE.interrupted
          : reason === 'timeout'
            ? `Stopped after ${Math.round((this.deps.maxTurnMs ?? 30 * 60_000) / 60_000)} minutes`
            : reason === 'output_limit'
              ? 'Stopped: the output was too large'
              : null,
      costKind,
    })
    if (entry.stopBeforeStart)
      return void (await endUnlaunched(
        stopCause(entry.stopBeforeStart),
        stopped(entry.stopBeforeStart),
      ))
    // An owned turn needs a supervised unit; a host that lost them since admission refuses it here.
    if (owner && !this.deps.unit?.usable())
      return void (await endUnlaunched('needs_units', {
        status: 'failed',
        error: 'Score can’t supervise coding runs right now.',
        costKind,
      }))
    // A queued turn may start long after admission: the CLI may have been replaced meanwhile.
    const refusal = await this.cliRefusal(agent, driver, true)
    if (refusal)
      return void (await endUnlaunched(refusal.cause, {
        status: 'failed',
        error: refusal.notice,
        costKind,
      }))
    // An earlier turn's tools may still be running (its group was never proven gone): no new turn until they have ended.
    if (this.hasUnresolvedGroup(agent.id))
      return void (await endUnlaunched('hold', {
        status: 'failed',
        error: UNRESOLVED_NOTE,
        costKind,
      }))
    // The folder may have changed since admission.
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok)
      return void (await endUnlaunched('workspace_unavailable', {
        status: 'failed',
        error: `The workspace is unavailable: ${checked.reason}`,
        costKind,
      }))
    // The final check before launching: a Stop or shutdown that arrived during the awaits above ends the turn unlaunched.
    if (entry.stopBeforeStart)
      return void (await endUnlaunched(
        stopCause(entry.stopBeforeStart),
        stopped(entry.stopBeforeStart),
      ))
    let settingsPath: string | null = null
    const settings = driver.settingsFile?.(this.denyPaths(), this.denyFiles())
    if (settings) {
      const dir = join(this.deps.home, 'coding', agent.id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      settingsPath = join(dir, settings.name)
      writeFileSync(settingsPath, settings.content, { mode: 0o600 })
      chmodSync(settingsPath, 0o600)
    }
    // The policy-built invocation of an owned worker is prepared right after Score wrote its settings file: every identity
    // is read again and the id computed from what will really run; a difference ends the run before anything is armed.
    let preparedPolicyId: string | undefined
    let resume = job && !owner ? cliSessionFor(db.sqlite, job, agent.id) : null
    // Event numbers keep counting across attempts: they name the observations, and a fallback's must not collide.
    let index = 0
    // One wall-clock budget for the whole turn, whichever launch it takes.
    const turnMs = this.deps.maxTurnMs ?? 30 * 60_000
    // An owned run's expiry never exceeds the orchestration's absolute deadline (7.7b §9); the executor's authorise
    // refuses the release if that deadline has moved earlier or passed by then.
    const deadline = Math.min(Date.now() + turnMs, owner?.deadlineAt ?? Infinity)
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: Extract<CodingEvent, { kind: 'result' }> | undefined
      // One terminal per attempt (re-review 6 #1): the first result stands, a second one is loss, never a replacement.
      let extraResult = false
      const text = new CappedText()
      // Anything the CLI did besides naming its session and reporting a result.
      let worked = false
      // Between fallback attempts too: nothing launches once Stop or shutdown has been asked for.
      if (entry.stopBeforeStart)
        return void (await endUnlaunched(
          stopCause(entry.stopBeforeStart),
          stopped(entry.stopBeforeStart),
        ))
      const parser = driver.createParser({ cwd: checked.real })
      const command = locator.nativeCommand(driver)
      if (!command.ok)
        return void (await endUnlaunched('cli_missing', {
          status: 'failed',
          error: command.message,
          costKind,
        }))
      const { file, args } = command
      if (frozenPolicy) {
        const checked = this.checkWorkerPolicy(agent.id, frozenPolicy.policy, command)
        if (!checked.ok)
          return void (await endUnlaunched(checked.cause, {
            status: 'failed',
            error: checked.detail,
            costKind,
          }))
        preparedPolicyId = checked.id
        if (checked.id !== frozenPolicy.id)
          return void (await endUnlaunched('agent_changed', {
            status: 'failed',
            error: `${driver.label} or its settings changed since this run was approved.`,
            costKind,
          }))
      }
      // Not a visible queued -> running step for a turn that has been stopped already.
      if (entry.stopBeforeStart)
        return void (await endUnlaunched(
          stopCause(entry.stopBeforeStart),
          stopped(entry.stopBeforeStart),
        ))
      await ingest
        .submit(runningObservation(translation))
        .catch((error: unknown) => this.deps.onError?.(error))
      if (entry.stopBeforeStart)
        return void (await endUnlaunched(
          stopCause(entry.stopBeforeStart),
          stopped(entry.stopBeforeStart),
        ))
      // The last admission boundary for the process-group engine: a restore, journal or coding fence raised since
      // admission keeps the CLI from starting (re-review 2 #2; decision 69 removed the fallback journal that held this).
      if (!this.deps.unit?.usable()) {
        const barrier = this.deps.frozen?.() ?? this.deps.unit?.block() ?? null
        if (barrier)
          return void (await endUnlaunched(this.deps.frozen?.() ? 'frozen' : 'fenced', {
            status: 'failed',
            error: barrier,
            costKind,
          }))
      }
      // The owner's role and instructions (PLAN 8.8): a 0600 file for a CLI with a flag for it, else in front of the
      // message. A new session (also the retry after a dead resume) is sent the block again; a resumed one only
      // when it changed since the session last received it.
      const frame = frameOf(agent)
      const sentHash = resume && job ? cliSessionInstructions(db.sqlite, job, agent.id) : ''
      const delivery: { prompt: string; file: string | null; refresh: boolean } = {
        prompt: input,
        file: null,
        refresh: false,
      }
      if (driver.instructions === 'file') {
        if (frame !== '') {
          const dir = join(this.deps.home, 'coding', agent.id)
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          delivery.file = join(dir, `instructions-${entry.runId}-${attempt}.md`)
          temporary.push(delivery.file)
          writeFileSync(delivery.file, frame, { mode: 0o600, flag: 'w' })
          chmodSync(delivery.file, 0o600)
        }
        delivery.refresh = resume !== null && (frame !== '' || sentHash !== '')
      } else {
        delivery.prompt = promptWithInstructions({
          frame,
          sent: sentHash,
          resumed: resume !== null,
          message: input,
        })
      }
      // 3.14.1 (owner): the agent's own advisor (Claude Code's --advisor), on every turn, in chats and job steps alike.
      const advisorModel = driver.runtime === 'claude-code' ? agent.advisorModel : null
      const cliArgs = [
        ...args,
        ...driver.buildArgs({
          workspace: checked.real,
          prompt: delivery.prompt,
          permission: agent.permission,
          model,
          effort: entry.effort ?? agent.effort,
          sessionId: resume,
          settingsPath: frozenPolicy?.policy.settings?.path ?? settingsPath,
          denyPaths: this.denyPaths(),
          denyFiles: this.denyFiles(),
          ...subagentDriverOptions(db.sqlite, agent.id, translation.subagentJobId),
          ...(frozenPolicy ? { worker: true } : {}),
          ...(delivery.file ? { instructionsFile: delivery.file } : {}),
          ...(delivery.refresh ? { refreshSystemPrompt: true } : {}),
          ...(advisorModel ? { advisorModel } : {}),
        }),
      ]
      const stdin = driver.promptVia === 'stdin' ? delivery.prompt : ''
      // Saving an event can fail. The supervised backend stops the run and the result is not used (design §4); the
      // fallback keeps the run going but cannot call it complete either.
      let threadId: string | null = null
      const handleEvent = async (event: CodingEvent): Promise<void> => {
        if (event.kind === 'session') threadId = event.sessionId
        if (event.kind === 'result') {
          if (result) extraResult = true
          else result = event
        }
        if (event.kind === 'text') text.push(event.text)
        if (event.kind !== 'session' && event.kind !== 'result') worked = true
        await ingest.submit(eventObservation(translation, event, index++))
      }

      const unit = this.deps.unit?.usable() ? this.deps.unit : undefined
      // Owned runs never take the process-group engine (checked above and at admission).
      if (owner && !unit)
        return void (await endUnlaunched('needs_units', {
          status: 'failed',
          error: 'Score can’t supervise coding runs right now.',
          costKind,
        }))
      const outcome = await this.launchAttempt(unit, {
        entry,
        agent,
        attempt,
        command: {
          file,
          args: cliArgs,
          env: { ...locator.childEnv(), ...driver.runEnv },
          cwd: checked.real,
          stdin,
        },
        parser,
        retainedBytes: () => translationBytes(translation) + text.size,
        deadline,
        preparedPolicyId,
        owner,
        stopCause,
        onEvent: handleEvent,
      })

      if (!outcome.groupGone) entry.unproven = true
      const stderr = oneLine(outcome.stderr, 400)
      // Loss anywhere in the stream (also after the result record) takes the authority away, decided once the whole
      // stream was processed (re-review #3). It is evaluated before anything else is decided from this attempt: a
      // record Score dropped may have been work (a tool call it could not read), so "nothing happened" is unprovable.
      const lost =
        parser.lossReason?.() ??
        (extraResult ? 'The CLI reported more than one result for this attempt' : null)
      if (!outcome.spawnError && outcome.refusal === null)
        this.recordQuota(agent, driver.runtime, parser.quota?.() ?? null, threadId, locator)
      // A resumed session the CLI refused before doing anything: start fresh once, and forget the dead id. Only with
      // proof that nothing ran: the first group is gone, no output or tool call was seen, and the CLI itself said the
      // session is unknown (a generic "not found" proves nothing). The second launch shares the turn's deadline.
      if (
        attempt === 0 &&
        !owner &&
        resume &&
        outcome.groupGone &&
        outcome.refusal === null &&
        !worked &&
        lost === null &&
        !outcome.stopped &&
        !outcome.spawnError &&
        outcome.complete &&
        deadline - Date.now() > 0 &&
        (outcome.exitCode !== 0 || result?.ok === false) &&
        refusesResume(driver, result?.error ?? stderr)
      ) {
        // Proven gone and nothing is being finished: the record goes now so the second launch can write its own.
        if (outcome.launchId) await unit?.settleLaunch(outcome.launchId, 'retried')
        else this.forgetProcess(entry.runId)
        if (job) forgetCliSession(db.sqlite, job, agent.id)
        resume = null
        continue
      }
      const verdict =
        lost !== null && result?.verdict
          ? { eligible: false, reply: null, reason: lost }
          : result?.verdict
      const ran = outcome.refusal === null
      let info: TerminalInfo
      if (outcome.stopped) info = stopped(outcome.stopped)
      else if (outcome.refusal) info = { status: 'failed', error: outcome.refusal, costKind }
      else if (outcome.spawnError)
        info = {
          status: 'failed',
          error:
            outcome.spawnError === 'python_unavailable'
              ? outcome.stderr
              : `Could not start ${driver.label} (${outcome.spawnError}).`,
          costKind,
        }
      else if (!outcome.complete)
        info = {
          status: 'failed',
          output: text.value || null,
          error: `Score couldn’t keep a complete record of this run, so its answer wasn’t used${
            outcome.reasons.length ? ` (${outcome.reasons.slice(0, 3).join(', ')})` : ''
          }.`,
          costKind,
        }
      else if (result && !result.ok)
        info = {
          status: 'failed',
          output: text.value || null,
          error: result.error ?? 'The run failed',
          costKind,
        }
      // The pinned driver's rule (design §6): explicit success with an authoritative reply, a clean exit and nothing
      // stopped it. A zero exit alone, or streamed commentary, never makes a result.
      // `completed` needs proof that every process of the run ended, decided here with the verdict (review #2): without
      // it the reply is only a candidate and never a result or a hand-off.
      else if (
        verdict?.eligible &&
        outcome.exitCode === 0 &&
        outcome.signal === null &&
        !outcome.groupGone
      )
        info = {
          status: 'failed',
          output: verdict.reply,
          reply: null,
          error:
            'The agent finished, but Score couldn’t confirm that everything it started has ended.',
          costKind,
        }
      else if (verdict?.eligible && outcome.exitCode === 0 && outcome.signal === null)
        info = { status: 'completed', output: verdict.reply, reply: verdict.reply, costKind }
      else
        info = {
          status: 'failed',
          output: text.value || null,
          error: `${driver.label} ended without a result Score can use${
            outcome.exitCode === null ? '' : ` (exit ${outcome.exitCode})`
          }${verdict?.reason ? `: ${verdict.reason}` : stderr ? `: ${stderr}` : ''}`,
          costKind,
        }
      // Plans and hand-offs read only an eligible authoritative reply (design v3 §5).
      if (ran && info.reply === undefined) info.reply = null
      if (outcome.launchId)
        unit?.noteEligibility(
          outcome.launchId,
          info.status === 'completed'
            ? 'eligible'
            : (verdict?.reason ?? outcome.reasons.join(', ')) || info.status,
        )
      if (outcome.leftovers && info.status === 'completed')
        info.output =
          `${info.output ?? ''}\n\nSome programs the agent started were still running when it finished, so Score stopped them.`.trim()
      // The record goes in the same transaction as the result, and only with proof the group ended. Without it the run
      // still ends (the reply is shown) but is marked unconfirmed, the record stays, and Score keeps stopping it.
      info.group = outcome.groupGone ? 'released' : 'unconfirmed'
      if (!outcome.groupGone)
        info.error =
          `${info.error ?? ''} Some programs the agent started couldn’t be stopped. ${UNRESOLVED_NOTE}`.trim()
      if (info.error) info.error = redact(info.error)
      if (owner) {
        info.ownedResult = true
        // A launch that ended before the CLI (revoked, refused) leaves its typed cause for the executor.
        if (outcome.refusal !== null && outcome.refusalCause !== null)
          this.recordRefusal(entry.runId, outcome.refusalCause, outcome.refusal)
      }
      // The CLI took this turn's prompt: its session now holds this block (a failed launch changes nothing).
      if (
        job &&
        !owner &&
        !outcome.spawnError &&
        outcome.refusal === null &&
        (threadId !== null || resume !== null)
      )
        try {
          rememberCliInstructions(db.sqlite, job, agent.id, blockHash(frame))
        } catch (error) {
          this.deps.onError?.(error)
        }
      await this.finish(translation, info)
      if (!outcome.groupGone) {
        if (outcome.launchId) void unit?.reap(outcome.launchId, this.deps.reapRetryMs)
        else void this.reapInBackground(entry.runId)
      }
      return
    }
  }
}

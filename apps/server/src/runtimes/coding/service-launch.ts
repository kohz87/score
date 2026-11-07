import { rmSync } from 'node:fs'
import { roomWorkspacePathFor } from '../../domain/workspaces.ts'
import type { OrchestrationOwner } from '../../domain/orchestration/owner.ts'
import { spawnCli, SpawnRecordError, type CliRun, type StopReason } from './process.ts'
import { oneLine, type ActiveRun, type Attempt } from './service-types.ts'
import { CodingRuntimeDelivery } from './service-delivery.ts'
import type { StoredCodingAgent } from './store.ts'
import type { CodingEvent, LineParser } from './types.ts'
import type { UnitBackend } from './unit-backend.ts'

interface AttemptLaunchInput {
  entry: ActiveRun
  agent: StoredCodingAgent
  attempt: number
  command: { file: string; args: string[]; env: Record<string, string>; cwd: string; stdin: string }
  parser: LineParser
  retainedBytes: () => number
  deadline: number
  preparedPolicyId: string | undefined
  owner: OrchestrationOwner | undefined
  stopCause: (reason: StopReason) => string
  onEvent: (event: CodingEvent) => Promise<void>
}

export abstract class CodingRuntimeLaunch extends CodingRuntimeDelivery {
  protected roomOf(turnId: string): string | null {
    const row = this.deps.db.sqlite
      .prepare('SELECT room_id FROM message_runs WHERE turn_id = ?')
      .get(turnId) as { room_id: string } | undefined
    return row?.room_id ?? null
  }

  /**
   * 3.20.0 (shared workspaces): the folder a chat turn of this agent works in. The room's workspace when the room has one
   * AND this agent is assigned to it, else the agent's own folder. It only names a folder: both callers (admission and
   * launch) run the result through `checkRoot`, so a coding agent never starts in a folder that failed the root policy.
   */
  protected workspaceFor(agent: StoredCodingAgent, roomId: string | null): string {
    if (roomId === null) return agent.workspace
    return roomWorkspacePathFor(this.deps.db.sqlite, roomId, agent.id) ?? agent.workspace
  }

  protected jobOf(turnId: string): string | null {
    const row = this.deps.db.sqlite
      .prepare('SELECT job_id FROM message_runs WHERE turn_id = ?')
      .get(turnId) as { job_id: string } | undefined
    return row?.job_id ?? null
  }

  /** Why an owned run ended before any launch was requested, for its executor (7.7b §6). The first reason stays. */
  protected recordRefusal(runId: string, cause: string, detail: string | null): void {
    try {
      this.deps.db.sqlite
        .prepare(
          'INSERT OR IGNORE INTO coding_refusals (run_id, cause, detail, at) VALUES (?, ?, ?, ?)',
        )
        .run(runId, cause, detail === null ? null : oneLine(detail, 300), new Date().toISOString())
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  protected async execute(
    entry: ActiveRun,
    admitted: StoredCodingAgent,
    input: string,
    job: string | null,
    model: string | null,
  ): Promise<void> {
    // The owner's instructions file (Claude Code) lives only as long as the run.
    const temporary: string[] = []
    try {
      await this.executeRun(temporary, entry, admitted, input, job, model)
    } finally {
      for (const file of temporary) rmSync(file, { force: true })
    }
  }

  protected abstract executeRun(
    temporary: string[],
    entry: ActiveRun,
    admitted: StoredCodingAgent,
    input: string,
    job: string | null,
    model: string | null,
  ): Promise<void>

  protected async launchAttempt(
    unit: UnitBackend | undefined,
    input: AttemptLaunchInput,
  ): Promise<Attempt> {
    const {
      entry,
      agent,
      attempt,
      command: { file, args: cliArgs, env, cwd, stdin },
      parser,
      retainedBytes,
      deadline,
      preparedPolicyId,
      owner,
      stopCause,
      onEvent,
    } = input
    let outcome: Attempt
    if (unit) {
      const unitRun = unit.launch({
        agentId: agent.id,
        runtime: agent.runtime,
        runId: entry.runId,
        turnId: entry.turnId,
        generation: attempt,
        command: { file, args: cliArgs, env, cwd, stdin },
        parser,
        retainedBytes,
        onEvent,
        deadline,
        graceMs: this.deps.graceMs ?? 5_000,
        authorised: owner
          ? () => true
          : () => !entry.stopBeforeStart && !this.closed && !this.hasUnresolvedGroup(agent.id),
        ...(owner
          ? {
              launchId: owner.launchId,
              owner: {
                orchestrationId: owner.orchestrationId,
                attemptId: owner.attemptId,
                generation: owner.generation,
              },
              ...(preparedPolicyId === undefined ? {} : { preparedPolicyId }),
              authorise: (
                prepared: Parameters<OrchestrationOwner['authorise']>[0],
                journal: Parameters<OrchestrationOwner['authorise']>[1],
              ) => {
                // The runtime's own reasons first, then the executor's decision (inside the critical section).
                if (entry.stopBeforeStart)
                  return { allowed: false as const, cause: stopCause(entry.stopBeforeStart) }
                if (this.closed) return { allowed: false as const, cause: 'restart' }
                if (this.hasUnresolvedGroup(agent.id))
                  return { allowed: false as const, cause: 'hold' }
                return owner.authorise(prepared, journal)
              },
            }
          : {}),
      })
      // Stop must wait for proof from here on: the unit may be starting.
      entry.launched = true
      entry.process = unitRun
      if (entry.stopBeforeStart) unitRun.stop(entry.stopBeforeStart)
      const done = await unitRun.done
      entry.process = undefined
      const exec = done.reasons.includes('supervisor-error:spawn')
      outcome = {
        exitCode: done.exitCode,
        signal: done.signal,
        stopped: done.stopped,
        stderr: done.stderr,
        spawnError: exec
          ? done.stderr.startsWith('pdeathsig-exec: cannot run')
            ? 'exec_failed'
            : 'spawn_failed'
          : done.exitCode === 127 && done.stderr.startsWith('pdeathsig-exec: cannot run')
            ? 'exec_failed'
            : null,
        leftovers: done.leftovers,
        groupGone: done.proven,
        complete: done.complete,
        refusal: done.refusal,
        reasons: done.reasons,
        launchId: done.launchId,
        refusalCause: done.refusalCause,
      }
    } else {
      let ingestFailed = false
      const spawnOptions: Parameters<typeof spawnCli>[0] = {
        file,
        args: cliArgs,
        cwd,
        env,
        onSpawn: (pid) => {
          this.recordProcess(entry.runId, pid)
          entry.launched = true
        },
        onMembers: (members) => this.recordMembers(entry.runId, members),
        onMembersError: (error) => this.deps.onError?.(error),
        // Every stop path of the group goes through one recording hook, before anything is signalled.
        onStop: (cause) => this.deps.onStop?.(cause),
        onStopError: (error) => this.deps.onError?.(error),
        stdin,
        parser,
        maxMs: Math.max(1, deadline - Date.now()),
        graceMs: this.deps.graceMs ?? 5_000,
        onEvent: (event) =>
          onEvent(event).catch((error: unknown) => {
            ingestFailed = true
            this.deps.onError?.(error)
          }),
      }
      let run: CliRun
      try {
        run = (this.deps.spawn ?? spawnCli)(spawnOptions)
      } catch (error) {
        // The process is already being killed: report nothing until it is proven gone.
        if (error instanceof SpawnRecordError) {
          await error.terminated.catch(() => false)
          throw error.original
        }
        throw error
      }
      entry.process = run
      if (entry.stopBeforeStart) entry.process.stop(entry.stopBeforeStart)
      const done = await run.done
      entry.process = undefined
      outcome = {
        exitCode: done.exitCode,
        signal: done.signal,
        stopped: done.stopped,
        stderr: done.stderr,
        spawnError: done.spawnError,
        leftovers: done.leftovers,
        groupGone: done.groupGone,
        // A partial last line, a read error or a dropped record is loss, as for the supervised unit.
        complete: !ingestFailed && done.streamComplete,
        refusal: null,
        reasons: [...(ingestFailed ? ['ingest-failure'] : []), ...done.streamLoss],
        launchId: null,
        refusalCause: null,
      }
    }
    return outcome
  }
}

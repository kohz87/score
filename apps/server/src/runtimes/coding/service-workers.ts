import { join } from 'node:path'
import type { WorkerReadiness } from '@score/contract'
import type { CodingWorkerFacts } from '../../domain/orchestration/supported-agents.ts'
import { checkRoot } from '../../workspace/policy.ts'
import { driverFor } from './drivers.ts'
import {
  buildPolicy,
  inputsOf,
  PolicyUnverifiable,
  policyIdOf,
  reachOf,
  type PolicyContext,
  type WorkerPolicy,
} from './policy.ts'
import { CodingRuntimeViews } from './service-views.ts'
import { getCodingAgent } from './store.ts'

export class CodingRuntimeWorkers extends CodingRuntimeViews {
  // ---------------------------------------------------------------------------------------- worker policy (7.7b §3)

  /** What the orchestration executor may ask about coding workers. */
  workerFacts(): CodingWorkerFacts {
    return {
      // The unit backend's own status: a frozen home or a fence is reported by `report()` with its own reason.
      unitHost: () => {
        const status = this.deps.unit?.status
        return status?.kind === 'unit' && status.checks.every((check) => check.ok)
      },
      agent: (id) => this.agents().find((agent) => agent.id === id),
      report: (id) => this.workerReport(id),
      checkPolicy: (id, policy) => this.checkWorkerPolicy(id, policy),
      quota: this.quotaSource(),
    }
  }

  protected policyContext(
    agentId: string,
    command: { file: string; args: readonly string[] },
    settingsOnDisk: boolean,
  ): PolicyContext {
    const env = this.deps.locator.childEnv()
    return {
      home: env['HOME'] ?? this.deps.policy.home,
      env,
      settingsDir: join(this.deps.home, 'coding', agentId),
      denyPaths: this.denyPaths(),
      denyFiles: this.denyFiles(),
      command,
      settingsOnDisk,
      checkedVersions: this.checkedVersions(),
    }
  }

  /**
   * The policy id of what would run for a stored policy right now, every identity read again (synchronously: the release
   * check calls it inside the journal's critical section). The inputs are the policy's own; the agent row is not consulted.
   */
  checkWorkerPolicy(
    agentId: string,
    policy: WorkerPolicy,
    command?: { file: string; args: readonly string[] },
  ):
    | { ok: true; id: string }
    | { ok: false; cause: 'agent_changed' | 'reach_unverifiable'; detail: string } {
    const driver = driverFor(policy.runtime)
    let resolved = command
    if (!resolved) {
      const native = this.deps.locator.nativeCommand(driver)
      if (!native.ok)
        return {
          ok: false,
          cause: 'agent_changed',
          detail: `${driver.label} can’t be found: ${native.message}`,
        }
      resolved = native
    }
    try {
      const current = buildPolicy(inputsOf(policy), this.policyContext(agentId, resolved, true))
      return { ok: true, id: policyIdOf(current) }
    } catch (error) {
      if (error instanceof PolicyUnverifiable)
        return { ok: false, cause: 'reach_unverifiable', detail: error.message }
      throw error
    }
  }

  /**
   * What preflight says about a coding agent as a worker: whether it can take a step now and, when it can, the policy the
   * person is asked to approve. The agent's current row is the only input; the CLI is asked for `--version` and nothing else.
   */
  async workerReport(agentId: string): Promise<{
    readiness: WorkerReadiness
    detail: string | null
    policy: WorkerPolicy | null
    policyId: string | null
    reach: string | null
    reachBeyondWorkspace: boolean
  }> {
    const none = (readiness: WorkerReadiness, detail: string) => ({
      readiness,
      detail,
      policy: null,
      policyId: null,
      reach: null,
      reachBeyondWorkspace: false,
    })
    const agent = getCodingAgent(this.deps.db.sqlite, agentId)
    if (!agent) return none('not_installed', 'Couldn’t find that coding agent.')
    const driver = driverFor(agent.runtime)
    const frozen = this.deps.frozen?.() ?? null
    if (frozen) return none('frozen', frozen)
    if (!this.deps.unit?.usable())
      return none(
        'needs_units',
        'Score can’t run coding agents as supervised services on this computer right now.',
      )
    const paused = this.deps.unit.block()
    if (paused) return none('paused', paused)
    // The version reading is the locator's cached one: the dialog asks often. A CLI replaced since is caught by its file
    // identity, which the launch reads again.
    const refusal = await this.cliRefusal(agent, driver, false)
    if (refusal) {
      const readiness: WorkerReadiness =
        refusal.cause === 'cli_missing'
          ? 'not_installed'
          : refusal.cause === 'reach_unverifiable'
            ? 'level_unverified'
            : 'reach_unverifiable'
      return none(readiness, refusal.notice)
    }
    const checked = await checkRoot(agent.workspace, this.deps.policy)
    if (!checked.ok)
      return none('reach_unverifiable', `The workspace is unavailable: ${checked.reason}`)
    const cli = await this.deps.locator.detect(driver)
    const native = this.deps.locator.nativeCommand(driver)
    if (!native.ok || cli.version === null)
      return none('not_installed', native.ok ? 'The CLI didn’t report a version.' : native.message)
    const unchecked = await this.checkVersion(driver, cli.version)
    if (unchecked) return none('reach_unverifiable', unchecked)
    try {
      const policy = buildPolicy(
        {
          runtime: agent.runtime,
          permission: agent.permission,
          model: agent.model,
          workspace: checked.real,
          version: cli.version,
        },
        this.policyContext(agent.id, native, false),
      )
      const reach = reachOf(policy)
      return {
        readiness: 'ready',
        detail: null,
        policy,
        policyId: policyIdOf(policy),
        reach: reach.text,
        reachBeyondWorkspace: reach.beyondWorkspace,
      }
    } catch (error) {
      if (error instanceof PolicyUnverifiable) return none('reach_unverifiable', error.message)
      throw error
    }
  }
}

import { subagentSessionsOf } from '../../domain/subagents.ts'
import type { HermesSubagentConfig } from '../profile-management.ts'
import { dropSubagentPolicy, subagentPolicyFor, writeSubagentPolicy } from './subagent-policy.ts'
import {
  applySubagentSetup,
  readSubagentConfig,
  readSubagentSetup,
  writeSubagentConfig,
} from './subagent-setup.ts'
import type { AgentDetail, AgentSummary, RunsOnUpdate } from '@score/contract'
import { homedir } from 'node:os'
import { HttpError } from '../../errors.ts'
import { resolveOnPath } from '../../runtimes/coding/native-exec.ts'
import { MemoryIdSchema } from '../agent-tabs.ts'
import type { ApprovalConfig } from '../approvals.ts'
import type { HermesPort } from '../port.ts'
import { readApprovalConfig, updateProfileApprovals } from './approvals.ts'
import { runHermes } from './cli.ts'
import { assertThawed } from './freeze.ts'
import { FIRST_STATUS_WAIT_MS } from './live-port-types.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { agentSummary } from './profiles.ts'
import { readAgentTodos } from './todos.ts'
import { RunRowSchema } from './translate.ts'
import type { LivePortRuntime } from './live-port-runtime.ts'

const hermesAgentIds = (agents: readonly { id: string }[]): string[] =>
  agents.map((agent) => agent.id)
const subagentSetupDeps = (port: LivePortRuntime) => ({
  runner: port.options.runner ?? runHermes,
  hermesHome: resolveHermesHome(port.options.hermesHome),
  home: (agentId: string) => port.agentHome(agentId),
})

export const agentMethods = {
  async subagentSetup(this: LivePortRuntime) {
    return readSubagentSetup(subagentSetupDeps(this), hermesAgentIds(await this.listAgents()))
  },
  refreshSubagentPolicies(this: LivePortRuntime, jobId: string): void {
    const { db } = this.requireStarted()
    db.read((sqlite) => {
      for (const { sessionId, profile, inline } of subagentSessionsOf(sqlite, jobId)) {
        // One unwritable file doesn't stop the job's other sessions getting the change.
        try {
          writeSubagentPolicy(
            this.options.scoreHome,
            sessionId,
            subagentPolicyFor(sqlite, profile, jobId, inline),
          )
        } catch (error) {
          this.options.onError?.(error)
          try {
            dropSubagentPolicy(this.options.scoreHome, sessionId)
          } catch (dropped) {
            this.options.onError?.(dropped)
          }
        }
      }
    })
  },
  async subagentConfig(this: LivePortRuntime, agentId: string) {
    return readSubagentConfig(subagentSetupDeps(this), agentId)
  },
  async setSubagentConfig(
    this: LivePortRuntime,
    agentId: string,
    change: Partial<HermesSubagentConfig>,
  ) {
    await writeSubagentConfig(subagentSetupDeps(this), agentId, change)
  },
  async applySubagentSetup(this: LivePortRuntime, agentIds: string[]) {
    const { db } = this.requireStarted()
    return applySubagentSetup(
      subagentSetupDeps(this),
      db,
      hermesAgentIds(await this.listAgents()),
      agentIds,
      () => new Date().toISOString(),
    )
  },
  async listAgents(this: LivePortRuntime): Promise<AgentSummary[]> {
    return (await this.listAgentDetails()).map(agentSummary)
  },
  profileInventory(this: LivePortRuntime, name: string, cloneFrom?: string) {
    return this.profileManagement.profileInventory(name, cloneFrom)
  },
  profileExportPath(this: LivePortRuntime, name: string, revision: string) {
    return this.profileManagement.profileExportPath(name, revision)
  },
  profileStep(this: LivePortRuntime, ...args: Parameters<HermesPort['profileStep']>) {
    return this.profileManagement.profileStep(...args)
  },
  describeProfile(this: LivePortRuntime, name: string, description: string) {
    return this.profileManagement.describeProfile(name, description)
  },
  listAgentDetails(this: LivePortRuntime): Promise<AgentDetail[]> {
    // A read that began before Score changed a profile's settings must not answer a caller that asked after.
    if (
      this.agentDetailsFlight &&
      this.agentDetailsFlightGeneration !== this.profiles.invalidations
    )
      this.agentDetailsFlight = undefined
    if (!this.agentDetailsFlight) {
      this.agentDetailsFlightGeneration = this.profiles.invalidations
      const mine = this.readAgentDetails().finally(() => {
        if (this.agentDetailsFlight === mine) this.agentDetailsFlight = undefined
      })
      this.agentDetailsFlight = mine
    }
    return this.agentDetailsFlight.then((details) => structuredClone(details))
  },
  async readAgentDetails(this: LivePortRuntime): Promise<AgentDetail[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.firstStatus,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.firstStatusWaitMs ?? FIRST_STATUS_WAIT_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    const served = this.current.hermes.servedProfiles
    const names = this.profiles.names(served)
    return Promise.all(
      names.map((profile, index) => {
        const active = (this.db ?? this.options.db)?.sqlite
          .prepare(
            `SELECT * FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') ORDER BY started_at DESC LIMIT 1`,
          )
          .get(profile)
        const row = active === undefined ? undefined : RunRowSchema.parse(active)
        return this.profiles.read(profile, index, served.includes(profile), {
          status:
            row?.status === 'waiting_for_approval'
              ? 'waiting'
              : row
                ? 'working'
                : served.includes(profile)
                  ? 'idle'
                  : 'offline',
          activity: row ? 'Running a turn' : null,
        })
      }),
    )
  },
  async listRoutines(this: LivePortRuntime, agentId: string) {
    return this.routines.list(agentId)
  },
  async createRoutine(
    this: LivePortRuntime,
    agentId: string,
    req: Parameters<HermesPort['createRoutine']>[1],
    key: string,
  ) {
    const { db } = this.requireStarted()
    return this.routines.create(agentId, req, key, db)
  },
  async patchRoutine(
    this: LivePortRuntime,
    id: string,
    req: Parameters<HermesPort['patchRoutine']>[1],
  ) {
    this.requireStarted()
    return this.routines.patch(id, req)
  },
  async deleteRoutine(this: LivePortRuntime, id: string) {
    this.requireStarted()
    await this.routines.remove(id)
  },
  async runRoutine(this: LivePortRuntime, id: string) {
    // A routine run is an agent turn: refused like every other outgoing execution while Score holds all agent work.
    assertThawed(this.options.frozen)
    this.requireStarted()
    await this.routines.run(id)
  },
  async setAgentModel(
    this: LivePortRuntime,
    agentId: string,
    req: Parameters<HermesPort['setAgentModel']>[1],
  ) {
    this.requireStarted()
    await this.tabs.setModel(agentId, req)
  },
  async readModelSettings(this: LivePortRuntime, agentId: string) {
    this.requireStarted()
    return this.tabs.getModelSettings(agentId)
  },
  async updateModelSettings(
    this: LivePortRuntime,
    agentId: string,
    req: Parameters<HermesPort['updateModelSettings']>[1],
  ) {
    this.requireStarted()
    return this.tabs.updateModelSettings(agentId, req)
  },
  async listSkills(this: LivePortRuntime, agentId: string) {
    return this.tabs.listSkills(agentId)
  },
  async installSkill(this: LivePortRuntime, agentId: string, identifier: string) {
    this.requireStarted()
    return this.tabs.installSkill(agentId, { name: identifier })
  },
  async setSkillEnabled(this: LivePortRuntime, agentId: string, name: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setSkillEnabled(agentId, name, enabled)
  },
  async searchSkillHub(this: LivePortRuntime, query: string) {
    return this.tabs.searchHub(query)
  },
  async readAgentTodos(this: LivePortRuntime, agentId: string) {
    return readAgentTodos(agentId, resolveHermesHome(this.options.hermesHome))
  },
  async listAgentChannels(this: LivePortRuntime, agentId: string) {
    return this.tabs.listChannels(agentId)
  },
  async listMemory(
    this: LivePortRuntime,
    agentId: string,
    query: Parameters<HermesPort['listMemory']>[1],
  ) {
    return this.tabs.listMemory(agentId, query)
  },
  async addMemory(this: LivePortRuntime, agentId: string): Promise<never> {
    return this.tabs.unsupportedMemoryWrite(agentId)
  },
  async deleteMemory(this: LivePortRuntime, agentId: string, id: string): Promise<never> {
    MemoryIdSchema.parse(id)
    return this.tabs.unsupportedMemoryWrite(agentId)
  },
  async readWorkspaceConfig(this: LivePortRuntime, agentId: string) {
    return this.tabs.readWorkspaceConfig(agentId)
  },
  async setWorkspaceCwd(this: LivePortRuntime, agentId: string, cwd: string) {
    this.requireStarted()
    return this.tabs.setWorkspaceCwd(agentId, cwd)
  },
  async readRunsOn(this: LivePortRuntime, agentId: string) {
    return this.tabs.readRunsOn(agentId)
  },
  async setRunsOn(this: LivePortRuntime, agentId: string, update: RunsOnUpdate) {
    this.requireStarted()
    return this.tabs.setRunsOn(agentId, update)
  },
  async setToolEnabled(this: LivePortRuntime, agentId: string, toolId: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setToolEnabled(agentId, toolId, enabled)
  },
  async listPlugins(this: LivePortRuntime, agentId: string) {
    this.requireStarted()
    return this.tabs.listPlugins(agentId)
  },
  async setPluginEnabled(this: LivePortRuntime, agentId: string, id: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setPluginEnabled(agentId, id, enabled)
  },
  interactiveCommand(
    this: LivePortRuntime,
    agentId: string,
  ): { file: string; args: string[]; cwd: string } | null {
    const parsed = ProfileNameSchema.safeParse(agentId)
    if (!parsed.success || !this.profiles.profileHome(parsed.data)) return null
    const file = resolveOnPath('hermes', process.env.PATH)
    if (!file) return null
    // `hermes -p <profile>` opens its interactive chat: messages and its own slash commands, as this user.
    return { file, args: ['-p', parsed.data], cwd: homedir() }
  },
  async restartGateway(this: LivePortRuntime, agentId: string): Promise<void> {
    const profile = this.approvalProfile(agentId)
    // No -y: for the shared gateway Hermes then refuses while sessions are live instead of interrupting them. Its output
    // stays private (cli.ts); the exit code is the answer, and the next tools/list is the proof.
    const result = await (this.options.runner ?? runHermes)(['-p', profile, 'gateway', 'restart'], {
      timeoutMs: 120_000,
      hermesHome: this.options.hermesHome,
      closeStdin: true,
    }).catch(() => ({ exitCode: -1 }))
    if (result.exitCode !== 0)
      throw new HttpError(
        502,
        'gateway_restart_failed',
        // -1: killed at the timeout or never started, so Hermes may still have restarted it.
        result.exitCode === -1
          ? `Hermes didn’t confirm the restart in time. Check it with: hermes -p ${profile} gateway status`
          : profile === 'default'
            ? 'Hermes didn’t restart the gateway. It refuses while any agent’s session is live; try again when nothing is running.'
            : `Hermes didn’t restart ${profile}’s gateway. Check it with: hermes -p ${profile} gateway status`,
      )
  },
  approvalProfile(this: LivePortRuntime, agentId: string): string {
    const parsed = ProfileNameSchema.safeParse(agentId)
    if (!parsed.success || !this.profiles.profileHome(parsed.data))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return parsed.data
  },
  async readApprovals(this: LivePortRuntime, agentId: string): Promise<ApprovalConfig> {
    return readApprovalConfig(
      this.options.runner ?? runHermes,
      resolveHermesHome(this.options.hermesHome),
      this.approvalProfile(agentId),
    )
  },
  // Writers within this process share the profile's queue; Hermes itself is the only other writer left to merge with.
  updateApprovals(
    this: LivePortRuntime,
    agentId: string,
    edit: (current: ApprovalConfig) => ApprovalConfig,
  ): Promise<ApprovalConfig> {
    const profile = this.approvalProfile(agentId)
    return this.locks.run(profile, () =>
      updateProfileApprovals(
        this.options.runner ?? runHermes,
        resolveHermesHome(this.options.hermesHome),
        profile,
        edit,
      ).finally(() => this.profiles.invalidate(profile)),
    )
  },
}

export type AgentMethods = typeof agentMethods

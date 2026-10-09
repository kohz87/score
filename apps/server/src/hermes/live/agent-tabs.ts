import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redact, redactBounded } from '../../redact.ts'
import {
  HubSkillSchema,
  ModelSettingsUpdateSchema,
  type ModelSettings,
  type ModelSettingsUpdate,
  type AgentChannelsResponse,
  type HubSkill,
  type MemoryItem,
  type MemoryPage,
  type PluginItem,
  PluginIdSchema,
  type SkillItem,
} from '@score/contract'
import {
  SetModelSchema,
  SkillNameSchema,
  ToolIdSchema,
  InstallSkillSchema,
  HubQuerySchema,
  pageMemory,
  MemoryQuerySchema,
  type AgentTool,
} from '../agent-tabs.ts'
import {
  HubRowsSchema,
  isBridgePlugin,
  readDisabledSkills,
  readLocalProviderIds,
  readModelPair,
  readTerminalConfig,
  readPlugins,
  readTools,
  RUN_TOOL_PLATFORM,
  WORKER_TOOL_PLATFORM,
} from './agent-config.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { readMemory } from './memory.ts'
import { messagingRows, readProfilePlatforms } from './settings.ts'
import { ProfileLocks } from './profile-locks.ts'
import { ProfileNameSchema } from './paths.ts'
import { skillNames } from './profiles.ts'
import { applyOps, deriveSettings, opArgs, planWrites, readRawSettings } from './model-settings.ts'

const HUB_LIMIT = 20

/** Model, skills, memory and tool edits for one Hermes profile, all through the `hermes` CLI. */
export class LiveAgentTabs {
  constructor(
    private readonly hermesHome: string,
    private readonly homeOf: (profile: string) => string | null,
    private readonly invalidate: (profile: string) => void,
    private readonly runner: HermesRunner = runHermes,
    private readonly locks: ProfileLocks = new ProfileLocks(),
  ) {}

  // Every change to a profile's config.yaml (model, skills, tools, plugins, approvals) shares one queue.
  private serial<T>(profile: string, work: () => Promise<T>): Promise<T> {
    return this.locks.run(profile, work)
  }
  private profile(agentId: string): { profile: string; home: string } {
    const parsed = ProfileNameSchema.safeParse(agentId)
    const home = parsed.success ? this.homeOf(parsed.data) : null
    if (!parsed.success || !home) throw new HttpError(404, 'not_found', 'Agent not found')
    return { profile: parsed.data, home }
  }
  private async mutate(profile: string, args: string[], timeoutMs = 15000): Promise<void> {
    const result = await this.runner(['-p', profile, ...args], {
      timeoutMs,
      hermesHome: this.hermesHome,
    }).catch(() => ({ exitCode: -1 }))
    this.invalidate(profile)
    if (result.exitCode !== 0)
      throw new HttpError(
        result.exitCode < 0 ? 502 : 409,
        result.exitCode < 0 ? 'hermes_unavailable' : 'conflict',
        'Hermes rejected the change',
      )
  }

  /** The agent's terminal folder and backend (Workspace tab); 502 when Hermes can't answer. */
  async readWorkspaceConfig(
    agentId: string,
  ): Promise<{ cwd: string | null; backend: string | null }> {
    const { profile } = this.profile(agentId)
    try {
      return await readTerminalConfig(this.runner, this.hermesHome, profile)
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Hermes could not be read')
    }
  }
  async setWorkspaceCwd(agentId: string, cwd: string): Promise<void> {
    const { profile } = this.profile(agentId)
    await this.serial(profile, () => this.mutate(profile, ['config', 'set', 'terminal.cwd', cwd]))
  }

  async setModel(agentId: string, input: z.infer<typeof SetModelSchema>): Promise<void> {
    const req = SetModelSchema.parse(input)
    const { profile } = this.profile(agentId)
    await this.serial(profile, async () => {
      // Local providers live in each profile's own config.yaml and the picker lists the default profile's, so a
      // provider only the default profile defines would save fine and then fail to resolve on this agent's runs.
      // Only a local provider needs the check; reads are cached, so this costs no CLI call on an unchanged config.
      if (req.provider && profile !== 'default') {
        const shared = await readLocalProviderIds(this.runner, this.hermesHome, 'default')
        if (shared?.has(req.provider)) {
          const own = await readLocalProviderIds(this.runner, this.hermesHome, profile)
          if (own && !own.has(req.provider))
            throw new HttpError(
              409,
              'conflict',
              'That local provider is not configured on this agent; add it to the agent profile first',
            )
        }
      }
      const prior = await readModelPair(this.runner, this.hermesHome, profile)
      // Without the current pair there is no way back from a half-applied change: stop before writing anything.
      if (prior === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          "The agent's current model could not be read, so it was not changed",
        )
      let wroteModel = false
      let wroteProvider = false
      try {
        // Each write is a Hermes process (seconds): a value that is already set is not written again.
        if (prior.model !== req.model) {
          wroteModel = true
          await this.mutate(profile, ['config', 'set', 'model.default', req.model])
        }
        if (req.provider && prior.provider !== req.provider) {
          wroteProvider = true
          await this.mutate(profile, ['config', 'set', 'model.provider', req.provider])
        }
      } catch (error) {
        // Two CLI writes are not atomic: put back what was changed, so a failure never leaves a new model paired
        // with the previous provider. Best effort; the request still reports the original failure.
        const undo = (args: string[]) => this.mutate(profile, args).catch(() => undefined)
        if (prior.scalar && prior.model && (wroteModel || wroteProvider))
          await undo(['config', 'set', 'model', prior.model])
        else {
          if (wroteModel && prior.model) await undo(['config', 'set', 'model.default', prior.model])
          if (wroteProvider) await undo(['config', 'set', 'model.provider', prior.provider ?? ''])
        }
        throw error
      }
    })
  }

  async getModelSettings(agentId: string): Promise<ModelSettings> {
    const { profile } = this.profile(agentId)
    return deriveSettings(await readRawSettings(this.runner, this.hermesHome, profile))
  }

  /** Writes only the keys that differ from what Hermes holds and answers from what was written (no re-read). */
  async updateModelSettings(agentId: string, input: ModelSettingsUpdate): Promise<ModelSettings> {
    const update = ModelSettingsUpdateSchema.parse(input)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const raw = await readRawSettings(this.runner, this.hermesHome, profile)
      const ops = planWrites(raw, update)
      for (const op of ops) await this.mutate(profile, opArgs(op))
      return deriveSettings(applyOps(raw, ops))
    })
  }

  /** Gateway state from this profile's own home; the connect command is shown, never run. */
  listChannels(agentId: string): AgentChannelsResponse {
    const { profile } = this.profile(agentId)
    return {
      items: messagingRows(readProfilePlatforms(this.hermesHome, profile)).map((row) => ({
        ...row,
        connectCommand: `hermes -p ${profile} gateway setup`,
      })),
    }
  }

  async listSkills(agentId: string): Promise<SkillItem[]> {
    const { profile, home } = this.profile(agentId)
    const disabled = new Set(
      (await readDisabledSkills(this.runner, this.hermesHome, profile)) ?? [],
    )
    return skillNames(home).map((name) => ({ name, enabled: !disabled.has(name) }))
  }
  async installSkill(
    agentId: string,
    input: z.infer<typeof InstallSkillSchema>,
  ): Promise<SkillItem[]> {
    const req = InstallSkillSchema.parse(input)
    const { profile } = this.profile(agentId)
    await this.serial(profile, () =>
      this.mutate(profile, ['skills', 'install', '--yes', '--', req.name], 120000),
    )
    return this.listSkills(agentId)
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem> {
    SkillNameSchema.parse(name)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const skills = await this.listSkills(agentId)
      if (!skills.some((skill) => skill.name === name))
        throw new HttpError(404, 'not_found', 'Skill not found')
      const current = await readDisabledSkills(this.runner, this.hermesHome, profile)
      if (current === null)
        throw new HttpError(502, 'hermes_unavailable', 'Skill settings unavailable')
      const next = new Set(current)
      if (enabled) next.delete(name)
      else next.add(name)
      if (current.includes(name) === enabled)
        await this.mutate(profile, [
          'config',
          'set',
          'skills.disabled',
          JSON.stringify([...next].sort()),
        ])
      return { name, enabled }
    })
  }
  async searchHub(query: string): Promise<HubSkill[]> {
    const q = HubQuerySchema.parse(query).trim()
    if (!q) return []
    const result = await this.runner(
      ['skills', 'search', '--json', '--limit', String(HUB_LIMIT), '--', q],
      { timeoutMs: 30000, hermesHome: this.hermesHome, captureRead: true },
    ).catch(() => ({ exitCode: -1 }) as { exitCode: number; stdout?: string })
    if (result.exitCode !== 0 || !result.stdout)
      throw new HttpError(502, 'hermes_unavailable', 'Skill search unavailable')
    let rows: z.infer<typeof HubRowsSchema>
    try {
      const text = result.stdout
      rows = HubRowsSchema.parse(JSON.parse(text.slice(Math.max(0, text.indexOf('[')))))
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Skill search unavailable')
    }
    return rows.slice(0, HUB_LIMIT).map((row) =>
      HubSkillSchema.parse({
        name: redactBounded(row.name ?? row.identifier, 200),
        identifier: row.identifier,
        source: redactBounded(row.source ?? '', 100),
        trust: redactBounded(row.trust_level ?? '', 50),
        description: redactBounded(row.description ?? '', 600),
      }),
    )
  }

  memory(agentId: string): MemoryItem[] {
    return readMemory(this.profile(agentId).home)
  }
  listMemory(agentId: string, query: z.infer<typeof MemoryQuerySchema>): MemoryPage {
    // Hermes has no per-entry memory command, so the page says it is read-only.
    return pageMemory(this.memory(agentId), MemoryQuerySchema.parse(query), false)
  }
  unsupportedMemoryWrite(agentId: string): never {
    this.profile(agentId)
    throw new HttpError(
      501,
      'not_implemented',
      'Hermes has no way to add or remove a single memory entry; memory is read-only in Score',
    )
  }

  async tools(agentId: string): Promise<AgentTool[]> {
    const { profile } = this.profile(agentId)
    return (await readTools(this.runner, this.hermesHome, profile)) ?? []
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool> {
    ToolIdSchema.parse(toolId)
    const { profile } = this.profile(agentId)
    return this.serial(profile, async () => {
      const tool = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!tool) throw new HttpError(404, 'not_found', 'Tool not found')
      if (tool.kind === 'mcp')
        throw new HttpError(
          501,
          'not_implemented',
          'MCP servers are toggled per tool in Hermes; Score shows them read-only',
        )
      if (tool.enabled !== enabled) {
        const verb = enabled ? 'enable' : 'disable'
        // Kanban workers read the cli platform; a toolset that platform refuses doesn't block the change
        // for Score's own runs, which are verified below.
        await this.mutate(profile, [
          'tools',
          verb,
          '--platform',
          WORKER_TOOL_PLATFORM,
          '--',
          toolId,
        ]).catch(() => undefined)
        await this.mutate(profile, ['tools', verb, '--platform', RUN_TOOL_PLATFORM, '--', toolId])
      }
      const after = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes did not apply the change')
      return { ...after, label: redact(after.label) }
    })
  }

  async listPlugins(agentId: string): Promise<PluginItem[]> {
    const { profile } = this.profile(agentId)
    const plugins = await readPlugins(this.runner, this.hermesHome, profile)
    if (!plugins) throw new HttpError(502, 'hermes_unavailable', 'Hermes could not list plugins')
    return plugins
  }
  /** `plugins enable|disable <name>`, then a re-read to verify. The Score bridge is never touched. */
  async setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<PluginItem> {
    PluginIdSchema.parse(id)
    const { profile } = this.profile(agentId)
    if (isBridgePlugin(id))
      throw new HttpError(
        409,
        'conflict',
        'The Score bridge stays on: Score needs it to see Hermes',
      )
    return this.serial(profile, async () => {
      const before = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!before) throw new HttpError(404, 'not_found', 'Plugin not found')
      if (before.enabled !== enabled)
        await this.mutate(profile, ['plugins', enabled ? 'enable' : 'disable', id])
      const after = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes did not apply the change')
      return after
    })
  }
}

import {
  ModelSettingsUpdateSchema,
  type AgentChannelsResponse,
  type AgentTodos,
  type HubSkill,
  type MemoryItem,
  type ModelSettings,
  type ModelSettingsUpdate,
  type PluginItem,
  type RoutineSummary,
  type RunsOn,
  type RunsOnUpdate,
  type SkillItem,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import {
  AddMemorySchema,
  HubQuerySchema,
  InstallSkillSchema,
  MemoryQuerySchema,
  SetModelSchema,
  pageMemory,
  type AgentTool,
} from '../agent-tabs.ts'
import { updateApprovalConfig, type ApprovalConfig } from '../approvals.ts'
import { CreateRoutineSchema, PatchRoutineSchema, type HermesPort } from '../port.ts'
import { describeRunsOn, type TerminalSettings } from '../runs-on.ts'
import { fakeHub, memoryId } from './fake-port-fixtures.ts'
import { FakePortProviders } from './fake-port-providers.ts'

export abstract class FakePortSettings extends FakePortProviders {
  async readApprovals(agentId: string): Promise<ApprovalConfig> {
    this.agentOrThrow(agentId)
    return structuredClone(
      this.approvalConfigs.get(agentId) ?? { mode: 'smart', allowlist: [], deny: [] },
    )
  }
  async updateApprovals(
    agentId: string,
    edit: (current: ApprovalConfig) => ApprovalConfig,
  ): Promise<ApprovalConfig> {
    // Same loop as the live adapter, over an in-memory "config".
    return updateApprovalConfig(
      {
        read: () => this.readApprovals(agentId),
        write: async (_current, next) => {
          this.approvalConfigs.set(agentId, structuredClone(next))
        },
      },
      edit,
    )
  }

  async setAgentModel(agentId: string, input: Parameters<HermesPort['setAgentModel']>[1]) {
    const req = SetModelSchema.parse(input)
    const agent = this.agentOrThrow(agentId)
    const model = { id: req.model, label: req.model }
    agent.model = model
    this.models.set(agentId, {
      model,
      via: req.provider ?? this.models.get(agentId)?.via ?? 'Demo',
    })
  }
  protected modelSettingsOf(agentId: string): ModelSettings {
    let settings = this.modelSettings.get(agentId)
    if (!settings) {
      settings = {
        effort: null,
        fallbacks: [],
        fallbacksEditable: true,
        aliases: [],
        speech: {
          stt: { provider: null, model: null },
          tts: { provider: 'edge', model: null, voice: 'en-US-AriaNeural' },
        },
      }
      this.modelSettings.set(agentId, settings)
    }
    return settings
  }
  async readModelSettings(agentId: string): Promise<ModelSettings> {
    this.agentOrThrow(agentId)
    return structuredClone(this.modelSettingsOf(agentId))
  }
  async updateModelSettings(agentId: string, input: ModelSettingsUpdate): Promise<ModelSettings> {
    const update = ModelSettingsUpdateSchema.parse(input)
    this.agentOrThrow(agentId)
    const settings = this.modelSettingsOf(agentId)
    if (update.effort !== undefined) settings.effort = update.effort
    if (update.fallbacks) settings.fallbacks = structuredClone(update.fallbacks)
    if (update.aliases)
      settings.aliases = update.aliases.map((alias) => ({
        name: alias.name,
        model: alias.model,
        provider: alias.provider ?? null,
        editable: true,
      }))
    Object.assign(settings.speech.stt, update.speech?.stt)
    Object.assign(settings.speech.tts, update.speech?.tts)
    return structuredClone(settings)
  }
  async listSkills(agentId: string): Promise<SkillItem[]> {
    this.agentOrThrow(agentId)
    return structuredClone(this.skills.get(agentId) ?? [])
  }
  async installSkill(agentId: string, identifier: string): Promise<SkillItem[]> {
    this.agentOrThrow(agentId)
    const name = InstallSkillSchema.parse({ name: identifier }).name.split('/').pop()!
    const skills = this.skills.get(agentId) ?? []
    if (!skills.some((skill) => skill.name === name)) skills.push({ name, enabled: true })
    this.skills.set(agentId, skills)
    return structuredClone(skills)
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem> {
    this.agentOrThrow(agentId)
    const skill = this.skills.get(agentId)?.find((candidate) => candidate.name === name)
    if (!skill) throw new HttpError(404, 'not_found', 'Couldn’t find that skill.')
    skill.enabled = enabled
    return structuredClone(skill)
  }
  async searchSkillHub(query: string): Promise<HubSkill[]> {
    const q = HubQuerySchema.parse(query).trim().toLowerCase()
    if (!q) return []
    return fakeHub.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q))
  }
  async readAgentTodos(agentId: string): Promise<AgentTodos> {
    this.agentOrThrow(agentId)
    // One neutral example list so the Todo card can be exercised; the other agents have none.
    if (agentId !== 'reviewer') return null
    return {
      todos: [
        { id: 'sketch', content: 'Sketch the settings page', status: 'completed' },
        { id: 'palette', content: 'Pick the accent colours', status: 'in_progress' },
        { id: 'contrast', content: 'Check contrast', status: 'pending', parent: 'palette' },
        { id: 'handoff', content: 'Hand the mock-ups to the builder', status: 'pending' },
      ],
      revision: 3,
      updatedAt: new Date(this.scheduler.now()).toISOString(),
    }
  }
  async listAgentChannels(agentId: string): Promise<AgentChannelsResponse> {
    this.agentOrThrow(agentId)
    const { messaging } = await this.listConnections()
    return {
      items: messaging.map((row) => ({
        ...row,
        connectCommand: `hermes -p ${agentId} gateway setup`,
      })),
    }
  }
  async listMemory(agentId: string, query: Parameters<HermesPort['listMemory']>[1]) {
    this.agentOrThrow(agentId)
    return pageMemory(this.memory.get(agentId) ?? [], MemoryQuerySchema.parse(query))
  }
  async addMemory(agentId: string, text: string): Promise<MemoryItem> {
    this.agentOrThrow(agentId)
    const clean = AddMemorySchema.parse({ text }).text.trim()
    const items = this.memory.get(agentId) ?? []
    const existing = items.find((item) => item.text === clean)
    if (existing) return structuredClone(existing)
    const item = {
      id: memoryId(clean),
      text: clean,
      source: 'Agent notes',
      at: new Date(this.scheduler.now()).toISOString(),
    }
    this.memory.set(agentId, [item, ...items])
    return structuredClone(item)
  }
  async deleteMemory(agentId: string, id: string): Promise<void> {
    this.agentOrThrow(agentId)
    const items = this.memory.get(agentId) ?? []
    if (!items.some((item) => item.id === id))
      throw new HttpError(404, 'not_found', 'Couldn’t find that memory entry.')
    this.memory.set(
      agentId,
      items.filter((item) => item.id !== id),
    )
  }

  workspaceDispose(): void {
    this.workspaces.dispose()
  }
  async readWorkspaceConfig(agentId: string) {
    this.agentOrThrow(agentId)
    return { cwd: this.workspaces.cwdOf(agentId), backend: this.workspaces.backendOf(agentId) }
  }
  async setWorkspaceCwd(agentId: string, cwd: string): Promise<void> {
    this.agentOrThrow(agentId)
    this.workspaces.set(agentId, cwd)
  }

  protected readonly terminals = new Map<string, TerminalSettings>()

  /** Fake mode answers as if Docker were installed, so the card's states can be shown and tested. */
  async readRunsOn(agentId: string): Promise<RunsOn> {
    this.agentOrThrow(agentId)
    return describeRunsOn(
      this.terminalOf(agentId),
      { names: ['score-fake'], addresses: ['127.0.0.1'] },
      '/home/fake',
    )
  }
  async setRunsOn(agentId: string, update: RunsOnUpdate): Promise<RunsOn> {
    this.agentOrThrow(agentId)
    const current = this.terminalOf(agentId)
    this.terminals.set(agentId, {
      ...current,
      backend: update.backend,
      ...(update.backend === 'docker'
        ? {
            dockerImage: update.image ?? current.dockerImage,
            dockerNetwork: update.network ?? current.dockerNetwork,
          }
        : {}),
      ...(update.backend === 'ssh'
        ? { sshHost: update.host, sshUser: update.user, sshPort: update.port ?? current.sshPort }
        : {}),
    })
    this.workspaces.setBackend(agentId, update.backend)
    return this.readRunsOn(agentId)
  }
  private terminalOf(agentId: string): TerminalSettings {
    return (
      this.terminals.get(agentId) ?? {
        backend: this.workspaces.backendOf(agentId),
        dockerImage: null,
        dockerNetwork: null,
        dockerMountCwd: null,
        dockerRunAsHostUser: null,
        dockerVolumes: null,
        dockerExtraArgs: null,
        dockerForwardEnv: null,
        sshHost: null,
        sshUser: null,
        sshPort: null,
      }
    )
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool> {
    this.agentOrThrow(agentId)
    const tool = this.tools.get(agentId)?.find((candidate) => candidate.id === toolId)
    if (!tool) throw new HttpError(404, 'not_found', 'Couldn’t find that tool.')
    if (tool.kind === 'mcp')
      throw new HttpError(501, 'not_implemented', 'MCP servers are shown read-only.')
    tool.enabled = enabled
    return structuredClone(tool)
  }

  async listPlugins(agentId: string): Promise<PluginItem[]> {
    return structuredClone(this.pluginsOf(agentId))
  }
  private pluginsOf(agentId: string): PluginItem[] {
    this.agentOrThrow(agentId)
    let plugins = this.plugins.get(agentId)
    if (!plugins) {
      const demo = (id: string, enabled: boolean, description: string | null, locked = false) => ({
        id,
        label: id,
        enabled,
        locked,
        description,
      })
      plugins = [
        demo('score-bridge', true, 'Lets Score see what this agent does.', true),
        demo('memory-notes', true, 'Keeps short notes between sessions.'),
        demo('browser-helper', false, 'Adds a cloud browser tool.'),
        demo('image-tools', false, null),
      ]
      this.plugins.set(agentId, plugins)
    }
    return plugins
  }
  async setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<PluginItem> {
    const plugin = this.pluginsOf(agentId).find((candidate) => candidate.id === id)
    if (!plugin) throw new HttpError(404, 'not_found', 'Couldn’t find that plugin.')
    if (plugin.locked)
      throw new HttpError(
        409,
        'conflict',
        'Score’s plugin stays on: Score needs it to see what this agent does.',
      )
    plugin.enabled = enabled
    return structuredClone(plugin)
  }

  protected routinesOf(agentId: string): RoutineSummary[] {
    return structuredClone(
      [...this.routines.values()].filter((routine) => routine.id.startsWith(`${agentId}:`)),
    )
  }
  private routine(id: string): RoutineSummary {
    const routine = this.routines.get(id)
    if (!routine) throw new HttpError(404, 'not_found', 'Couldn’t find that routine.')
    return routine
  }
  async listRoutines(agentId: string): Promise<RoutineSummary[]> {
    if (!this.agents.has(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return this.routinesOf(agentId)
  }
  async createRoutine(
    agentId: string,
    input: Parameters<HermesPort['createRoutine']>[1],
    key: string,
  ): Promise<RoutineSummary> {
    const req = CreateRoutineSchema.parse(input)
    if (!this.agents.has(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const intent = `${agentId}:${key}`
    const known = this.routineKeys.get(intent)
    if (known) return structuredClone(this.routine(known))
    const id = `${agentId}:fake-routine-${++this.routineCount}`
    const routine: RoutineSummary = {
      id,
      title: req.title,
      schedule: req.schedule,
      description: req.prompt.slice(0, 600),
      lastRunAt: null,
      enabled: true,
      ...(req.model ? { model: req.model.model, provider: req.model.provider } : {}),
      nextRunAt: new Date(Date.parse(this.now()) + 3_600_000).toISOString(),
    }
    this.routines.set(id, routine)
    this.routineKeys.set(intent, id)
    return structuredClone(routine)
  }
  async patchRoutine(
    id: string,
    input: Parameters<HermesPort['patchRoutine']>[1],
  ): Promise<RoutineSummary> {
    const req = PatchRoutineSchema.parse(input)
    const routine = this.routine(id)
    if (req.enabled !== undefined) routine.enabled = req.enabled
    if (req.schedule !== undefined) routine.schedule = req.schedule
    if (req.prompt !== undefined) routine.description = req.prompt.slice(0, 600)
    if (req.title !== undefined) routine.title = req.title
    if (req.model !== undefined) {
      routine.model = req.model?.model ?? null
      routine.provider = req.model?.provider ?? null
    }
    return structuredClone(routine)
  }
  async moveRoutine(
    id: string,
    agentId: string,
    key: string,
  ): Promise<{ job: RoutineSummary; leftBehind: string | null }> {
    const routine = this.routine(id)
    if (id.startsWith(`${agentId}:`)) return { job: structuredClone(routine), leftBehind: null }
    const moved = await this.createRoutine(
      agentId,
      {
        title: routine.title,
        schedule: routine.schedule,
        prompt: routine.description || routine.title,
        ...(routine.model
          ? { model: { model: routine.model, provider: routine.provider ?? null } }
          : {}),
      },
      `move:${key}`,
    )
    const made = this.routine(moved.id)
    made.enabled = routine.enabled
    this.routineOutputs.set(moved.id, this.routineOutputs.get(id) ?? [])
    this.routines.delete(id)
    return { job: structuredClone(made), leftBehind: null }
  }
  async readRoutineOutputs(
    id: string,
    since: string,
  ): Promise<{ file: string; at: string; text: string }[]> {
    return (this.routineOutputs.get(id) ?? []).filter((output) => output.at > since)
  }
  async deleteRoutine(id: string): Promise<void> {
    this.routine(id)
    this.routines.delete(id)
  }
  async runRoutine(id: string): Promise<void> {
    // Real Hermes runs on its next tick; the fake records the run, and saves a result, immediately.
    const routine = this.routine(id)
    routine.lastRunAt = this.now()
    const outputs = this.routineOutputs.get(id) ?? []
    outputs.push({
      file: `${routine.lastRunAt.slice(0, 19).replace('T', '_').replaceAll(':', '-')}.md`,
      at: routine.lastRunAt,
      text: `${routine.title}: done. (A result from the fake agent.)`,
    })
    this.routineOutputs.set(id, outputs)
  }
  async pinFollowingRoutines(agentId: string): Promise<string[]> {
    if (!this.agents.has(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const model = (this.models.get(agentId)?.model ?? this.agents.get(agentId)?.model)?.id ?? null
    const pinned: string[] = []
    for (const routine of this.routines.values())
      if (routine.id.startsWith(`${agentId}:`) && !routine.model && model) {
        routine.model = model
        pinned.push(routine.id)
      }
    return pinned
  }
}

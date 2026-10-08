import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redact, redactBounded } from '../../redact.ts'
import {
  HubSkillSchema,
  SetModelSchema,
  SkillNameSchema,
  ToolIdSchema,
  InstallSkillSchema,
  HubQuerySchema,
  pageMemory,
  MemoryQuerySchema,
  type AgentTool,
  type HubSkill,
  type MemoryItem,
  type MemoryPage,
  type SkillItem,
} from '../agent-tabs.ts'
import { HubRowsSchema, readDisabledSkills, readTools } from './agent-config.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { readMemory } from './memory.ts'
import { ProfileNameSchema } from './paths.ts'
import { skillNames } from './profiles.ts'

const HUB_LIMIT = 20

/** Model, skills, memory and tool edits for one Hermes profile, all through the `hermes` CLI. */
export class LiveAgentTabs {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly hermesHome: string,
    private readonly homeOf: (profile: string) => string | null,
    private readonly invalidate: (profile: string) => void,
    private readonly runner: HermesRunner = runHermes,
  ) {}

  // Skill and tool toggles read the list, change it and write it back; serialize them within this process.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.catch(() => undefined)
    return result
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

  async setModel(agentId: string, input: z.infer<typeof SetModelSchema>): Promise<void> {
    const req = SetModelSchema.parse(input)
    const { profile } = this.profile(agentId)
    await this.mutate(profile, ['config', 'set', 'model.default', req.model])
    if (req.provider) await this.mutate(profile, ['config', 'set', 'model.provider', req.provider])
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
    await this.mutate(profile, ['skills', 'install', '--yes', '--', req.name], 120000)
    return this.listSkills(agentId)
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem> {
    SkillNameSchema.parse(name)
    const { profile } = this.profile(agentId)
    return this.serial(async () => {
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
    return pageMemory(this.memory(agentId), MemoryQuerySchema.parse(query))
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
    return readTools(this.runner, this.hermesHome, profile)
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool> {
    ToolIdSchema.parse(toolId)
    const { profile } = this.profile(agentId)
    return this.serial(async () => {
      const tool = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!tool) throw new HttpError(404, 'not_found', 'Tool not found')
      if (tool.kind === 'mcp')
        throw new HttpError(
          501,
          'not_implemented',
          'MCP servers are toggled per tool in Hermes; Score shows them read-only',
        )
      if (tool.enabled !== enabled)
        await this.mutate(profile, ['tools', enabled ? 'enable' : 'disable', '--', toolId])
      const after = (await this.tools(agentId)).find((candidate) => candidate.id === toolId)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes did not apply the change')
      return { ...after, label: redact(after.label) }
    })
  }
}

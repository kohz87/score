import type { RunsOn, RunsOnUpdate } from '@score/contract'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { describeRunsOn, type TerminalSettings, type ThisMachine } from '../runs-on.ts'
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
  configJson,
  readTerminalConfig,
  readPlugins,
  readTools,
  RUN_TOOL_PLATFORM,
  WORKER_TOOL_PLATFORM,
} from './agent-config.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { dockerAnswers } from './docker-check.ts'
import { readMemory } from './memory.ts'
import { messagingRows, readProfilePlatforms } from './settings.ts'
import { ProfileLocks } from './profile-locks.ts'
import { ProfileNameSchema } from './paths.ts'
import { skillNames } from './profiles.ts'
import {
  applyOps,
  deriveSettings,
  opArgs,
  planWrites,
  readRawSettings,
  undoOps,
} from './model-settings.ts'

const HUB_LIMIT = 20

/** Model, skills, memory and tool edits for one Hermes profile, all through the `hermes` CLI. */
// A local provider's key under `providers.`: no dots, since Hermes reads a dot as a nested key.
const LocalProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

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
    if (!parsed.success || !home) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
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
        'Hermes didn’t accept the change.',
      )
  }

  /**
   * Copies a local provider the default profile defines into another profile: its name, address and default model,
   * nothing else (a key, if any, stays where it is). Under that profile's config lock.
   */
  async copyLocalProvider(profile: string, providerId: string, source = 'default'): Promise<void> {
    const parsed = ProfileNameSchema.parse(profile)
    if (parsed === source) return
    await this.serial(parsed, async () => {
      const own = await readLocalProviderIds(this.runner, this.hermesHome, parsed)
      if (own === null)
        throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the agent’s providers.')
      if (!own.has(providerId)) await this.copyProviderUnlocked(parsed, providerId, source)
    })
  }
  /** Whether the profile's config defines this local provider; null when it can't be read. */
  async definesLocalProvider(profile: string, providerId: string): Promise<boolean | null> {
    const own = await readLocalProviderIds(
      this.runner,
      this.hermesHome,
      ProfileNameSchema.parse(profile),
    )
    return own === null ? null : own.has(providerId)
  }
  /**
   * `config unset providers.<id>` in one profile (2.0.3): always the full key, never `providers` itself (that would drop
   * every local provider). A dotted id would address a nested key, so it is refused.
   */
  async removeLocalProvider(profile: string, providerId: string): Promise<void> {
    const parsed = ProfileNameSchema.parse(profile)
    const id = LocalProviderIdSchema.parse(providerId)
    await this.serial(parsed, () => this.mutate(parsed, ['config', 'unset', `providers.${id}`]))
    if ((await this.definesLocalProvider(parsed, id)) !== false)
      throw new HttpError(409, 'not_verified', 'Hermes still lists that provider.')
  }
  private async copyProviderUnlocked(
    profile: string,
    providerId: string,
    from = 'default',
  ): Promise<void> {
    const id = LocalProviderIdSchema.parse(providerId)
    // The whole section: only `providers` is an allowlisted read (cli.ts); just three fields of one entry are used.
    const read = await configJson(this.runner, this.hermesHome, from, 'providers')
    const entry =
      read.state === 'ok' && read.value && typeof read.value === 'object'
        ? (read.value as Record<string, unknown>)[id]
        : undefined
    if (entry === undefined)
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read that local provider.')
    const source = z
      .object({
        name: z.string().min(1).max(200).optional(),
        base_url: z.string().min(1).max(2000),
        default_model: z.string().min(1).max(256).optional(),
      })
      .safeParse(entry)
    if (!source.success)
      throw new HttpError(
        409,
        'conflict',
        'That local provider can’t be copied: its settings are incomplete.',
      )
    // The address first: Hermes (and Score's list) ignore an entry without one, so a copy cut short is either usable
    // or invisible, never a half entry that `own.has` would mistake for a finished copy.
    const fields: [string, string][] = [
      ['base_url', source.data.base_url],
      ['name', source.data.name ?? id],
      ...(source.data.default_model
        ? [['default_model', source.data.default_model] as [string, string]]
        : []),
    ]
    for (const [key, value] of fields)
      await this.mutate(profile, ['config', 'set', `providers.${id}.${key}`, value])
  }

  /** The agent's terminal folder and backend (Workspace tab); 502 when Hermes can't answer. */
  async readWorkspaceConfig(
    agentId: string,
  ): Promise<{ cwd: string | null; backend: string | null }> {
    const { profile } = this.profile(agentId)
    try {
      return await readTerminalConfig(this.runner, this.hermesHome, profile)
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read this agent from Hermes.')
    }
  }
  async setWorkspaceCwd(agentId: string, cwd: string): Promise<void> {
    const { profile } = this.profile(agentId)
    await this.serial(profile, () => this.mutate(profile, ['config', 'set', 'terminal.cwd', cwd]))
  }

  /** Whether Docker answers here; a field so tests can stand in for the daemon. */
  dockerReady: () => Promise<boolean> = () => dockerAnswers()

  async readRunsOn(agentId: string): Promise<RunsOn> {
    const { profile } = this.profile(agentId)
    return describeRunsOn(await this.terminalSettings(profile), thisMachine(), homedir())
  }
  private async terminalValue(profile: string, key: string): Promise<unknown> {
    const answer = await configJson(this.runner, this.hermesHome, profile, key)
    if (answer.state === 'unavailable')
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read this agent from Hermes.')
    return answer.state === 'ok' ? answer.value : null
  }
  private async terminalSettings(profile: string): Promise<TerminalSettings> {
    const read = (key: string) => this.terminalValue(profile, `terminal.${key}`)
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)
    // Hermes coerces "true"/"false" on write, but a hand-edited config can still hold the string.
    const flag = (value: unknown) =>
      typeof value === 'boolean'
        ? value
        : value === 'true'
          ? true
          : value === 'false'
            ? false
            : null
    const backend = text(await read('backend'))
    const name = backend?.trim().toLowerCase()
    const docker = name === 'docker'
    const ssh = name === 'ssh'
    const port = ssh ? await read('ssh_port') : null
    return {
      backend,
      dockerImage: docker ? text(await read('docker_image')) : null,
      dockerNetwork: docker ? flag(await read('docker_network')) : null,
      dockerMountCwd: docker ? flag(await read('docker_mount_cwd_to_workspace')) : null,
      dockerRunAsHostUser: docker ? flag(await read('docker_run_as_host_user')) : null,
      dockerVolumes: docker ? await read('docker_volumes') : null,
      dockerExtraArgs: docker ? await read('docker_extra_args') : null,
      dockerForwardEnv: docker ? await read('docker_forward_env') : null,
      sshHost: ssh ? text(await read('ssh_host')) : null,
      sshUser: ssh ? text(await read('ssh_user')) : null,
      sshPort: typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null,
    }
  }
  async setRunsOn(agentId: string, update: RunsOnUpdate): Promise<RunsOn> {
    const { profile } = this.profile(agentId)
    if (update.backend === 'docker' && !(await this.dockerReady()))
      throw new HttpError(
        409,
        'backend_unavailable',
        'Docker isn’t installed or running on this machine.',
      )
    // Settings first and `terminal.backend` last. Omitted Docker fields stay as they are; SSH's port and key go back
    // to Hermes's defaults when omitted, so a new host never inherits the last host's key.
    const writes: [string, string][] = []
    if (update.backend === 'docker') {
      if (update.image !== undefined) writes.push(['terminal.docker_image', update.image])
      if (update.network !== undefined)
        writes.push(['terminal.docker_network', update.network ? 'true' : 'false'])
    }
    if (update.backend === 'ssh')
      writes.push(
        ['terminal.ssh_host', update.host],
        ['terminal.ssh_user', update.user],
        ['terminal.ssh_port', String(update.port ?? 22)],
        ['terminal.ssh_key', update.keyPath ?? ''],
      )
    writes.push(['terminal.backend', update.backend])
    return this.serial(profile, async () => {
      // A failure part-way puts back what was written, so the agent keeps running exactly where it did.
      const before = new Map<string, unknown>()
      for (const [key] of writes) before.set(key, await this.terminalValue(profile, key))
      const done: string[] = []
      try {
        for (const [key, value] of writes) {
          await this.mutate(profile, ['config', 'set', key, value])
          done.push(key)
        }
      } catch (error) {
        for (const key of done.reverse()) {
          const prior = before.get(key)
          const value =
            prior === null || prior === undefined
              ? ''
              : typeof prior === 'string'
                ? prior
                : JSON.stringify(prior)
          await this.mutate(profile, ['config', 'set', key, value]).catch(() => undefined)
        }
        throw error
      }
      return describeRunsOn(await this.terminalSettings(profile), thisMachine(), homedir())
    })
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
          // A local provider Score added lives in the default profile: copy it into this agent's profile first, so the
          // person's choice in Score is enough (2.0.3).
          if (own && !own.has(req.provider)) await this.copyProviderUnlocked(profile, req.provider)
        }
      }
      const prior = await readModelPair(this.runner, this.hermesHome, profile)
      // Without the current pair there is no way back from a half-applied change: stop before writing anything.
      if (prior === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t read the agent’s current model, so nothing was changed.',
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
      const attempted: typeof ops = []
      try {
        for (const op of ops) {
          // Counted before it runs: a write that timed out may still have landed.
          attempted.push(op)
          await this.mutate(profile, opArgs(op))
        }
      } catch (error) {
        // The CLI writes one key at a time: put back what this save already changed, so a failure leaves no
        // half-applied settings. Best effort; the request still reports the original failure. (A crash between two
        // writes can't be undone this way; the next read shows what Hermes holds.)
        for (const op of undoOps(raw, attempted))
          await this.mutate(profile, opArgs(op)).catch(() => undefined)
        throw error
      }
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
        throw new HttpError(404, 'not_found', 'Couldn’t find that skill.')
      const current = await readDisabledSkills(this.runner, this.hermesHome, profile)
      if (current === null)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Couldn’t read the skill settings from Hermes.',
        )
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
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t search skills. Check that Hermes is reachable.',
      )
    let rows: z.infer<typeof HubRowsSchema>
    try {
      const text = result.stdout
      rows = HubRowsSchema.parse(JSON.parse(text.slice(Math.max(0, text.indexOf('[')))))
    } catch {
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t search skills. Check that Hermes is reachable.',
      )
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
      'Hermes has no way to add or remove a single memory entry, so memory is read-only in Score.',
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
      if (!tool) throw new HttpError(404, 'not_found', 'Couldn’t find that tool.')
      if (tool.kind === 'mcp')
        throw new HttpError(
          501,
          'not_implemented',
          'MCP servers are switched on or off per tool in Hermes. Score shows them read-only.',
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
        throw new HttpError(409, 'conflict', 'Hermes didn’t apply the change.')
      return { ...after, label: redact(after.label) }
    })
  }

  async listPlugins(agentId: string): Promise<PluginItem[]> {
    const { profile } = this.profile(agentId)
    const plugins = await readPlugins(this.runner, this.hermesHome, profile)
    if (!plugins)
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t list the plugins from Hermes.')
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
        'Score’s plugin stays on: Score needs it to see what this agent does.',
      )
    return this.serial(profile, async () => {
      const before = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!before) throw new HttpError(404, 'not_found', 'Couldn’t find that plugin.')
      if (before.enabled !== enabled)
        await this.mutate(profile, ['plugins', enabled ? 'enable' : 'disable', id])
      const after = (await this.listPlugins(agentId)).find((plugin) => plugin.id === id)
      if (!after || after.enabled !== enabled)
        throw new HttpError(409, 'conflict', 'Hermes didn’t apply the change.')
      return after
    })
  }
}

/** This machine's names and addresses, so SSH to it in any spelling reads as "not separated". */
function thisMachine(): ThisMachine {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .flatMap((item) => (item ? [item.address.replace(/%.*$/u, '')] : []))
  return { names: [hostname()], addresses }
}

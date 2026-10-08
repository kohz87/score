import fs from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { AgentSummarySchema, type AgentSummary } from '@score/contract'
import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { defaultAgentStyle } from '../../domain/agents.ts'
import { redact, redactBounded } from '../../redact.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { excerpt } from '../agent-files.ts'
import { ProfileNameSchema } from './paths.ts'
import { readRoutines } from './routines.ts'
import { readDisabledSkills, readHelpersMax, readTools } from './agent-config.ts'
import { readMemory } from './memory.ts'
import { MEMORY_DETAIL_ITEMS } from '../agent-tabs.ts'
import { permissionsOf } from '../approvals.ts'
import { readApprovalConfig } from './approvals.ts'

const allowedFiles = z.enum(['SOUL.md', 'AGENTS.md', 'profile.yaml', 'config.yaml'])
const readableFiles = allowedFiles.extract(['SOUL.md', 'profile.yaml'])
const ModelSchema = z.union([
  z.string().min(1),
  z.object({
    default: z.string().min(1),
    provider: z.string().optional(),
    fallback: z.string().nullable().optional(),
  }),
])
const MetadataSchema = z.object({
  display_name: z.string().optional(),
  description: z.string().optional(),
  role: z.string().optional(),
})

function directory(path: string): boolean {
  try {
    return fs.lstatSync(path).isDirectory()
  } catch {
    return false
  }
}
function fileStat(home: string, name: z.infer<typeof allowedFiles>): fs.Stats | null {
  const path = join(home, allowedFiles.parse(name))
  try {
    const stat = fs.lstatSync(path)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}
function readText(home: string, name: z.infer<typeof readableFiles>): string {
  const stat = fileStat(home, name)
  if (!stat || stat.size > 256 * 1024) return ''
  try {
    const fd = fs.openSync(
      join(home, readableFiles.parse(name)),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    try {
      const buffer = Buffer.alloc(256 * 1024 + 1)
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0)
      return length > 256 * 1024
        ? ''
        : z.string().parse(buffer.subarray(0, length).toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}
function metadata(text: string): z.infer<typeof MetadataSchema> {
  const values: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const match = /^(display_name|description|role):\s*(.*)$/.exec(lines[index]!)
    if (!match) continue
    let value = match[2]!.trim()
    if (/^[|>][-+]?\s*$/.test(value)) {
      const block: string[] = []
      while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1]!))
        block.push(lines[++index]!.trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim()
    } else if (value.startsWith('"')) {
      try {
        value = z.string().parse(JSON.parse(value))
      } catch {
        continue
      }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'")) continue
      value = value.slice(1, -1).replaceAll("''", "'")
    } else {
      if (/^[!&*[{]/.test(value)) continue
      value = value.replace(/\s+#.*$/, '').trim()
    }
    values[match[1]!] = redactBounded(value, 2000)
  }
  return MetadataSchema.parse(values)
}
export function skillNames(home: string): string[] {
  const names: string[] = []
  const walk = (path: string, depth: number) => {
    if (depth > 8 || !directory(path)) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      names.push(basename(path))
      return
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !/credential|secret|auth/i.test(entry.name) &&
        !['references', 'assets', 'scripts', 'templates', 'node_modules'].includes(entry.name)
      )
        walk(join(path, entry.name), depth + 1)
    }
  }
  walk(join(home, 'skills'), 0)
  return [...new Set(names)].sort().map(redact)
}

interface Settings {
  disabledSkills: string[]
  tools: AgentDetail['tools']
  helpersMax: number | null
  permissions: AgentDetail['permissions']
}
export class ProfilesReader {
  private readonly models = new Map<string, { signature: string; value: AgentDetail['model'] }>()
  private readonly settings = new Map<string, { signature: string; value: Settings }>()
  constructor(
    private readonly hermesHome: string,
    private readonly runner: HermesRunner = runHermes,
  ) {}

  names(servedProfiles: string[]): string[] {
    const names = new Set(z.array(ProfileNameSchema).parse(['default', ...servedProfiles]))
    if (directory(this.hermesHome) && directory(join(this.hermesHome, 'profiles'))) {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(join(this.hermesHome, 'profiles'), { withFileTypes: true })
      } catch {
        /* A profile directory can disappear during reconciliation. */
      }
      for (const entry of entries) {
        if (entry.isDirectory() && ProfileNameSchema.safeParse(entry.name).success)
          names.add(entry.name)
      }
    }
    return [...names].sort()
  }
  /** The profile's directory when it exists and is not a symlink; the only input to the file writer. */
  profileHome(profile: string): string | null {
    if (!directory(this.hermesHome)) return null
    if (profile === 'default') return this.hermesHome
    const parent = join(this.hermesHome, 'profiles')
    const path = join(parent, ProfileNameSchema.parse(profile))
    return directory(parent) && directory(path) ? path : null
  }
  /** Drops cached CLI reads for a profile after Score changed its settings. */
  invalidate(profile: string): void {
    this.models.delete(profile)
    this.settings.delete(profile)
  }
  // Settings kept in config.yaml are read through the CLI and cached by the file's signature.
  private async configSettings(profile: string, home: string | null): Promise<Settings> {
    const unknown: Settings = { disabledSkills: [], tools: [], helpersMax: null, permissions: [] }
    if (!home) return unknown
    const stat = fileStat(home, 'config.yaml')
    if (!stat) return unknown
    const signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    const cached = this.settings.get(profile)
    if (cached?.signature === signature) return cached.value
    const [disabled, tools, helpersMax, approvals] = await Promise.all([
      readDisabledSkills(this.runner, this.hermesHome, profile),
      readTools(this.runner, this.hermesHome, profile),
      readHelpersMax(this.runner, this.hermesHome, profile),
      readApprovalConfig(this.runner, this.hermesHome, profile).catch(() => null),
    ])
    const value = {
      disabledSkills: disabled ?? [],
      tools,
      helpersMax,
      permissions: permissionsOf(approvals),
    }
    this.settings.set(profile, { signature, value })
    return value
  }
  private async model(profile: string, home: string | null): Promise<AgentDetail['model']> {
    // The contract's detail model is null when it can't be read (§8).
    const unavailable = null
    if (!home) return unavailable
    const stat = fileStat(home, 'config.yaml')
    if (!stat) return unavailable
    const signature = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    const cached = this.models.get(profile)
    if (cached?.signature === signature) return cached.value
    try {
      const result = await this.runner(['-p', profile, 'config', 'get', '--json', 'model'], {
        timeoutMs: 5000,
        hermesHome: this.hermesHome,
        captureModel: true,
      })
      if (result.exitCode !== 0 || !result.stdout || Buffer.byteLength(result.stdout) > 16 * 1024)
        return unavailable
      const model = ModelSchema.parse(JSON.parse(result.stdout))
      const value =
        typeof model === 'string'
          ? { id: redact(model), label: redact(model), via: 'Hermes configuration', fallback: null }
          : {
              id: redact(model.default),
              label: redact(model.default),
              via: redact(model.provider ?? 'Hermes configuration'),
              fallback: model.fallback ? redact(model.fallback) : null,
            }
      this.models.set(profile, { signature, value })
      return value
    } catch {
      return unavailable
    }
  }
  async read(
    profile: string,
    index: number,
    served: boolean,
    activity: Pick<AgentSummary, 'status' | 'activity'>,
  ): Promise<AgentDetail> {
    ProfileNameSchema.parse(profile)
    const home = this.profileHome(profile)
    const meta = metadata(home ? readText(home, 'profile.yaml') : '')
    const soul = redact(home ? readText(home, 'SOUL.md') : '')
    const settings = await this.configSettings(profile, home)
    const disabled = new Set(settings.disabledSkills)
    return AgentDetailSchema.parse({
      id: profile,
      name: meta.display_name || profile,
      role: meta.description || meta.role || 'Agent',
      style: defaultAgentStyle(index),
      ...activity,
      served,
      tagline: meta.description || '',
      personality: {
        excerpt: excerpt(soul),
        source: 'SOUL.md',
      },
      reportsTo: null,
      worksIn: null,
      rulesFile: home && fileStat(home, 'AGENTS.md') ? 'AGENTS.md' : null,
      model: await this.model(profile, home),
      skills: home ? skillNames(home).map((name) => ({ name, enabled: !disabled.has(name) })) : [],
      memory: home ? readMemory(home).slice(0, MEMORY_DETAIL_ITEMS) : [],
      tools: settings.tools,
      helpersMax: settings.helpersMax,
      routines: home ? readRoutines(this.hermesHome, profile) : [],
      channels: [],
      permissions: settings.permissions,
    })
  }
}
export function agentSummary(detail: AgentDetail): AgentSummary {
  return AgentSummarySchema.parse(detail)
}

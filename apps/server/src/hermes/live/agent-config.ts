import { z } from 'zod'
import { redact, redactBounded } from '../../redact.ts'
import type { AgentTool } from '../agent-tabs.ts'
import { PluginIdSchema, type PluginItem } from '@score/contract'
import { type HermesRunner } from './cli.ts'

// Reads of per-profile settings that Hermes keeps in config.yaml. Score never opens that file: it asks the
// CLI for exactly these values (allowlisted in cli.ts) and degrades to "unknown" when the CLI can't answer.
const DisabledSchema = z.array(z.string().min(1).max(200)).max(5000)
const HelpersSchema = z.int().nonnegative().max(1000)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

type Captured = { state: 'ok'; text: string } | { state: 'unset' } | { state: 'unavailable' }
async function captureResult(
  runner: HermesRunner,
  hermesHome: string,
  args: string[],
): Promise<Captured> {
  try {
    const result = await runner(args, { timeoutMs: 10000, hermesHome, captureRead: true })
    if (result.exitCode === 0 && result.stdout) return { state: 'ok', text: result.stdout }
    // `config get` exits 1 for a key that was never set (hermes_cli/config.py `_exit_invalid`); a timeout,
    // a signal or a missing binary reports -1 and says nothing about the setting.
    return result.exitCode === 1 ? { state: 'unset' } : { state: 'unavailable' }
  } catch {
    return { state: 'unavailable' }
  }
}
async function capture(
  runner: HermesRunner,
  hermesHome: string,
  args: string[],
): Promise<string | null> {
  const result = await captureResult(runner, hermesHome, args)
  return result.state === 'ok' ? result.text : null
}
async function configJson(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
  key: string,
): Promise<{ state: 'ok'; value: unknown } | { state: 'unset' } | { state: 'unavailable' }> {
  const result = await captureResult(runner, hermesHome, [
    '-p',
    profile,
    'config',
    'get',
    '--json',
    key,
  ])
  if (result.state !== 'ok') return result
  try {
    return { state: 'ok', value: JSON.parse(result.text) }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Disabled skill names; null when unreadable (callers that write must stop). A never-set key is an empty list. */
export async function readDisabledSkills(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
): Promise<string[] | null> {
  const read = await configJson(runner, hermesHome, profile, 'skills.disabled')
  if (read.state === 'unset') return []
  if (read.state === 'unavailable') return null
  const parsed = DisabledSchema.safeParse(read.value)
  return parsed.success ? parsed.data : null
}
export async function readHelpersMax(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
): Promise<number | null> {
  const read = await configJson(runner, hermesHome, profile, 'delegation.max_concurrent_children')
  if (read.state !== 'ok') return null
  const parsed = HelpersSchema.safeParse(read.value)
  return parsed.success ? parsed.data : null
}

const ToolRowSchema = /^\s+[✓✗]\s+(enabled|disabled)\s+(\S+)(?:\s+(.*))?$/u
/** Parses the plain-text `tools list` output: toolset rows (built-in and plugin) and MCP server rows. */
export function parseToolList(text: string): AgentTool[] {
  const tools: AgentTool[] = []
  let section: 'toolsets' | 'mcp' | null = null
  for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
    if (/^(Built-in|Plugin) toolsets\b/.test(line)) section = 'toolsets'
    else if (/^MCP servers:/.test(line)) section = 'mcp'
    else if (section === 'toolsets') {
      const row = ToolRowSchema.exec(line)
      if (row)
        tools.push({
          id: row[2]!,
          label: redact((row[3] ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || row[2]!),
          kind: 'builtin',
          enabled: row[1] === 'enabled',
        })
    } else if (section === 'mcp') {
      const row = /^\s+(\S+)\s+(.*)$/.exec(line)
      if (row)
        tools.push({
          id: row[1]!,
          label: redact(row[1]!),
          kind: 'mcp',
          enabled: !/include only: \(none\)/.test(row[2]!),
        })
    }
  }
  const seen = new Set<string>()
  return tools.filter(
    (tool) =>
      z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
        .safeParse(tool.id).success &&
      !seen.has(tool.id) &&
      !!seen.add(tool.id),
  )
}
/**
 * Score-started runs go through the gateway's API server, so its toolset list is what a toggle must change.
 * `hermes tools` defaults to the `cli` platform (hermes_cli/subcommands/tools.py), which Kanban workers use.
 */
export const RUN_TOOL_PLATFORM = 'api_server'
export const WORKER_TOOL_PLATFORM = 'cli'
/** null when Hermes can't answer, so callers can tell "no tools" from "unknown". */
export async function readTools(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
): Promise<AgentTool[] | null> {
  const text = await capture(runner, hermesHome, [
    '-p',
    profile,
    'tools',
    'list',
    '--platform',
    RUN_TOOL_PLATFORM,
  ])
  return text === null ? null : parseToolList(text)
}

export const HubRowsSchema = z.array(
  z
    .object({
      name: z.string().nullish(),
      identifier: z.string().min(1).max(400),
      source: z.string().nullish(),
      trust_level: z.string().nullish(),
      description: z.string().nullish(),
    })
    .passthrough(),
)

const PluginRowsSchema = z.array(
  z.object({
    name: PluginIdSchema,
    status: z.string(),
    description: z.string().nullish(),
  }),
)
/** The Score bridge is how Score sees Hermes: disabling it from Score would cut Score off. */
export function isBridgePlugin(name: string): boolean {
  return name.replaceAll('_', '-') === 'score-bridge'
}
/** `plugins list --json` for one profile; null when Hermes can't answer. Rows with odd names are skipped. */
export async function readPlugins(
  runner: HermesRunner,
  hermesHome: string,
  profile: string,
): Promise<PluginItem[] | null> {
  const text = await capture(runner, hermesHome, ['-p', profile, 'plugins', 'list', '--json'])
  if (text === null) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(json)) return null
  return json.flatMap((row): PluginItem[] => {
    const parsed = PluginRowsSchema.element.safeParse(row)
    if (!parsed.success) return []
    const { name, status, description } = parsed.data
    return [
      {
        id: name,
        label: redact(name),
        enabled: status === 'enabled',
        locked: isBridgePlugin(name),
        description: description ? redactBounded(description, 300) : null,
      },
    ]
  })
}

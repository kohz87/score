import { z } from 'zod'
import type {
  CodingDriver,
  CodingEvent,
  DriverRunOptions,
  LineParser,
  ToolDetail,
  UsageReading,
} from './types.ts'

// Antigravity CLI (`agy`, PLAN 7.6), headless: `agy -p <prompt> --output-format stream-json`. Event shapes are the ones
// recorded from agy 1.3.3 (apps/server/test/fixtures/coding/antigravity-*.jsonl): `init`, `step_update`, `result`.
// Anything else is counted and dropped.

const Envelope = z.object({ event: z.string() }).loose()
const Init = z.object({
  event: z.literal('init'),
  conversation_id: z.string().min(1),
})
const Usage = z
  .object({
    input_tokens: z.number().finite().nonnegative().optional(),
    output_tokens: z.number().finite().nonnegative().optional(),
  })
  .loose()
const Step = z.object({
  event: z.literal('step_update'),
  step_update: z
    .object({
      step_index: z.int().nonnegative(),
      state: z.string(),
      step_type: z.string(),
      text_delta: z.string().optional(),
      tool_name: z.string().optional(),
      tool_info: z
        .object({
          name: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        })
        .loose()
        .optional(),
    })
    .loose(),
})
const Result = z.object({
  event: z.literal('result'),
  result: z
    .object({
      status: z.string(),
      response: z.string().optional(),
      usage: Usage.optional(),
      denied_actions: z
        .array(z.object({ action: z.string().optional(), display_name: z.string().optional() }))
        .optional(),
    })
    .loose(),
})

const FILE_EDIT_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
])
const BROWSER_TOOL =
  /^(?:browser_|open_browser_url$|read_browser_page$|read_url_content$|search_web$|capture_browser_|click_browser_|execute_browser_|list_browser_)/

/** The first string parameter whose name matches (the captures only show `CommandLine`; other names are matched by shape). */
function param(params: Record<string, unknown> | undefined, name: RegExp): string | null {
  if (!params) return null
  for (const [key, value] of Object.entries(params))
    if (name.test(key) && typeof value === 'string' && value.trim()) return value
  return null
}

function toolDetail(
  tool: string,
  params: Record<string, unknown> | undefined,
  cwd: string | undefined,
): { preview: string; detail?: ToolDetail } {
  if (tool === 'run_command') {
    const command = param(params, /^(?:CommandLine|command)$/i)
    if (!command) return { preview: '' }
    const where = param(params, /^(?:Cwd|WorkingDirectory|workdir|cwd)$/i) ?? cwd
    return {
      preview: command,
      detail: { type: 'command', command, ...(where ? { cwd: where } : {}) },
    }
  }
  if (FILE_EDIT_TOOLS.has(tool)) {
    const path = param(params, /(?:path|file|target|uri)/i)
    // File content never goes into a frame: only that the file changed (the argument names are not recorded).
    return path
      ? { preview: path, detail: { type: 'file', path, change: 'update' } }
      : { preview: '' }
  }
  if (BROWSER_TOOL.test(tool)) {
    const url = param(params, /url/i)
    return { preview: url ?? '', detail: { type: 'browser', url } }
  }
  return { preview: param(params, /(?:path|file|query|pattern|url|dir)/i) ?? '' }
}

export function createAntigravityParser(cwd?: string): LineParser {
  const stats = { unknown: 0, malformed: 0 }
  const started = new Set<number>()
  let spoke = false
  return {
    stats,
    parse(line) {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        stats.malformed++
        return []
      }
      const envelope = Envelope.safeParse(value)
      if (!envelope.success) {
        stats.malformed++
        return []
      }
      const kind = envelope.data.event
      if (kind === 'init') {
        const init = Init.safeParse(value)
        if (!init.success) {
          stats.unknown++
          return []
        }
        return [{ kind: 'session', sessionId: init.data.conversation_id }]
      }
      if (kind === 'step_update') {
        const parsed = Step.safeParse(value)
        if (!parsed.success) {
          stats.unknown++
          return []
        }
        const step = parsed.data.step_update
        if (step.step_type === 'user_input') return []
        if (step.step_type === 'agent_response') {
          // Both the ACTIVE and the closing DONE step carry deltas; the closing one is the trailing newline.
          if (!step.text_delta) return []
          spoke = true
          return [{ kind: 'text', text: step.text_delta }]
        }
        if (step.step_type !== 'tool') {
          stats.unknown++
          return []
        }
        const tool = step.tool_name ?? step.tool_info?.name
        if (!tool) {
          stats.unknown++
          return []
        }
        const callId = `step-${step.step_index}`
        const events: CodingEvent[] = []
        if (!started.has(step.step_index)) {
          started.add(step.step_index)
          events.push({
            kind: 'tool_start',
            callId,
            tool,
            ...toolDetail(tool, step.tool_info?.parameters, cwd),
          })
        }
        if (['DONE', 'ERROR', 'FAILED', 'CANCELLED', 'CANCELED'].includes(step.state))
          events.push({ kind: 'tool_end', callId, ok: step.state === 'DONE', preview: '' })
        return events
      }
      if (kind === 'result') {
        const parsed = Result.safeParse(value)
        if (!parsed.success) {
          stats.unknown++
          return []
        }
        const { status, response, usage, denied_actions: denied = [] } = parsed.data.result
        const events: CodingEvent[] = []
        if (usage)
          // `output_tokens` already counts the thinking tokens (total = input + output in the captures).
          events.push({
            kind: 'usage',
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          })
        // What the level refused, as cards: "Antigravity refused: RunCommand".
        denied.forEach((action, index) => {
          const name = action.display_name ?? action.action ?? 'an action'
          events.push(
            { kind: 'tool_start', callId: `denied-${index}`, tool: 'Antigravity refused', preview: name },
            { kind: 'tool_end', callId: `denied-${index}`, ok: false, preview: `Refused: ${name}` },
          )
        })
        const ok = status === 'SUCCESS'
        const refused = denied.map((action) => action.display_name ?? action.action ?? 'an action')
        const note = refused.length
          ? `Antigravity refused: ${refused.join(', ')}. This agent's permission level does not allow it.`
          : undefined
        // Streamed text is the reply; only a turn that said nothing falls back to the final response or the refusal note.
        const text = spoke ? undefined : response?.trim() ? response : note
        events.push(
          ok
            ? { kind: 'result', ok: true, ...(text ? { text } : {}) }
            : {
                kind: 'result',
                ok: false,
                error: response?.trim() || `Antigravity ended with status ${status}`,
              },
        )
        return events
      }
      stats.unknown++
      return []
    },
  }
}

/**
 * `agy -p /usage --output-format json`: a JSON wrapper around a tab-separated table (per model group, the 5-hour and
 * weekly "limit remaining" with reset times). The exact layout is read defensively; `text` always keeps the table.
 */
export function parseAntigravityUsage(output: string): UsageReading {
  const strings: string[] = []
  const collect = (value: unknown, depth: number): void => {
    if (depth > 6) return
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1)
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) collect(item, depth + 1)
  }
  try {
    collect(JSON.parse(output), 0)
  } catch {
    strings.push(output)
  }
  const text = strings.join('\n').trim().slice(0, 8000)
  const groups: UsageReading['groups'] = []
  for (const line of text.split('\n')) {
    const cells = line
      .split(/\t+| {2,}/)
      .map((cell) => cell.trim())
      .filter(Boolean)
    const percents = cells.flatMap((cell) => {
      const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(cell)
      return match ? [{ cell, value: Math.min(100, Number(match[1])) }] : []
    })
    const name = cells.find((cell) => !/%/.test(cell) && /[A-Za-z]/.test(cell) && !/^reset/i.test(cell))
    if (!name || percents.length === 0) continue
    // A reset time is either its own cell or what is left of the percent cell once the percentage is cut out.
    const resets = [
      ...percents.map((p) => p.cell.replace(/\d{1,3}(?:\.\d+)?\s*%/, '').replace(/[()·|,-]/g, ' ').trim()),
      ...cells.filter((cell) => !/%/.test(cell) && cell !== name && /\d/.test(cell)),
    ].filter(Boolean)
    groups.push({
      name,
      fiveHourRemainingPercent: percents[0]?.value ?? null,
      fiveHourResets: resets[0] ?? null,
      weeklyRemainingPercent: percents[1]?.value ?? null,
      weeklyResets: resets[1] ?? null,
    })
  }
  return { groups, text }
}

export const antigravityDriver: CodingDriver = {
  runtime: 'antigravity',
  label: 'Antigravity (agy)',
  executable: 'agy',
  testedVersions: ['1.3.3'],
  supported: true,
  quota: 'Uses your Google Antigravity plan quota (5-hour and weekly limits).',
  promptVia: 'argv',
  // Flipped by the lead after each level is live-verified (decoy-file read/write probes); see SCORE_CODING_VERIFIED_ANTIGRAVITY.
  verifiedPermissions: [],
  warning:
    'Antigravity can also browse the web, generate images, schedule work and run sub-agents, beyond editing files.',
  requiresReadAck: true,
  usage: { args: ['-p', '/usage', '--output-format', 'json'], parse: parseAntigravityUsage },
  parseVersion(output) {
    return output.length > 400 ? null : (/\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null)
  },
  buildArgs(options: DriverRunOptions) {
    // The prompt is an argument here (agy has no stdin mode). A message starting with "/" would run an agy command
    // (`/usage`, `/plan`…) and one starting with "-" could read as a flag: neither is ever sent bare.
    const prompt = /^[/-]/.test(options.prompt) ? `Message: ${options.prompt}` : options.prompt
    if (Buffer.byteLength(prompt) > 100_000)
      throw new Error('The message is too long for Antigravity (its prompt goes in a command line)')
    const args = ['-p', prompt, '--output-format', 'stream-json']
    if (options.permission === 'read-only') args.push('--mode', 'plan', '--sandbox')
    else if (options.permission === 'workspace-write')
      args.push('--mode', 'accept-edits', '--sandbox')
    else args.push('--dangerously-skip-permissions')
    if (options.sessionId) args.push('--conversation', options.sessionId)
    if (options.model) args.push('--model', options.model)
    return args
  },
  createParser: (options) => createAntigravityParser(options.cwd),
}

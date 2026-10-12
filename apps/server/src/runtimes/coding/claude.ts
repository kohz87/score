import { withBounds } from './note.ts'
import { z } from 'zod'
import { redact } from '../../redact.ts'
import type {
  CodingDriver,
  CodingEvent,
  DriverRunOptions,
  LineParser,
  ToolDetail,
} from './types.ts'

// Claude Code, headless: `claude -p --output-format stream-json --verbose`. Event shapes follow Anthropic's documented
// stream-json output (system/init, assistant, user, result). Parsed defensively: anything that doesn't match is counted
// and dropped, never stored raw.

const ContentBlock = z.object({ type: z.string() }).loose()
const TextBlock = z.object({ type: z.literal('text'), text: z.string() })
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() })
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
})
const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
})
const Envelope = z.object({ type: z.string() }).loose()
const InitEvent = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  model: z.string().optional(),
})
const MessageEvent = z.object({
  type: z.enum(['assistant', 'user']),
  message: z.object({ content: z.union([z.string(), z.array(ContentBlock)]) }).loose(),
})
const ResultEvent = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().finite().nonnegative().optional(),
  usage: z
    .object({
      input_tokens: z.number().finite().nonnegative().optional(),
      output_tokens: z.number().finite().nonnegative().optional(),
      cache_creation_input_tokens: z.number().finite().nonnegative().optional(),
      cache_read_input_tokens: z.number().finite().nonnegative().optional(),
    })
    .loose()
    .optional(),
})

// Records and blocks Score knows it can ignore, named explicitly (FW #5): notices and partial stream events that carry
// neither the answer nor a failure. Anything else Score can't understand is loss for the whole attempt (it could have
// been the final result or the error that contradicts an earlier success).
const IGNORABLE_RECORDS = new Set(['stream_event', 'rate_limit_event', 'keep_alive'])
const IGNORABLE_BLOCKS = new Set(['image', 'redacted_thinking', 'document'])

const PATH_KEYS = ['file_path', 'path', 'notebook_path']
function preview(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const pick = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null)
  if (tool === 'Bash') return pick('command') ?? ''
  for (const key of [...PATH_KEYS, 'pattern', 'url', 'query']) {
    const value = pick(key)
    if (value) return value
  }
  try {
    // Redact before the cut: a clipped label would leave its value unrecognisable.
    return redact(JSON.stringify(input)).slice(0, 300)
  } catch {
    return ''
  }
}

function detail(tool: string, input: unknown, cwd: string | undefined): ToolDetail | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const str = (key: string) =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined
  if (tool === 'Bash') {
    const command = str('command')
    return command === undefined ? undefined : { type: 'command', command, ...(cwd ? { cwd } : {}) }
  }
  const path = str('file_path')
  if (tool === 'Write' && path !== undefined && str('content') !== undefined)
    return { type: 'write', path, content: str('content')! }
  if (tool === 'Edit' && path !== undefined && str('old_string') !== undefined)
    return {
      type: 'replace',
      path,
      oldString: str('old_string')!,
      newString: str('new_string') ?? '',
    }
  return undefined
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('')
  return ''
}

export function createClaudeParser(cwd?: string): LineParser {
  return withBounds(createInnerClaudeParser(cwd))
}

function createInnerClaudeParser(cwd?: string): LineParser {
  const stats = { unknown: 0, malformed: 0 }
  let spoke = false
  // Sticky for the whole attempt, also after the result record (like Codex): decided once the stream was processed.
  let lossNote: string | null = null
  const lose = (note: string) => {
    lossNote ??= note
  }
  return {
    stats,
    lossReason: () =>
      lossNote ?? (stats.malformed > 0 ? 'Score dropped a record of this turn' : null),
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
      const events: CodingEvent[] = []
      const init = InitEvent.safeParse(value)
      const envelopeType = envelope.data.type
      if (
        !init.success &&
        envelopeType === 'system' &&
        (value as { subtype?: unknown }).subtype === 'init'
      )
        lose('Claude Code sent a record Score could not validate')
      if (init.success) {
        return [
          {
            kind: 'session',
            sessionId: init.data.session_id,
            ...(init.data.model ? { model: init.data.model } : {}),
          },
        ]
      }
      const message = MessageEvent.safeParse(value)
      if (!message.success && (envelopeType === 'assistant' || envelopeType === 'user')) {
        stats.unknown++
        lose('Claude Code sent a record Score could not validate')
        return events
      }
      if (message.success) {
        const content = message.data.message.content
        if (typeof content === 'string') {
          if (message.data.type === 'assistant' && content) {
            events.push({ kind: 'text', text: spoke ? `\n\n${content}` : content })
            spoke = true
          }
          return events
        }
        for (const block of content) {
          const text = TextBlock.safeParse(block)
          const thinking = ThinkingBlock.safeParse(block)
          const use = ToolUseBlock.safeParse(block)
          const result = ToolResultBlock.safeParse(block)
          if (text.success && message.data.type === 'assistant') {
            if (!text.data.text) continue
            events.push({ kind: 'text', text: spoke ? `\n\n${text.data.text}` : text.data.text })
            spoke = true
          } else if (thinking.success && message.data.type === 'assistant') {
            if (thinking.data.thinking)
              events.push({ kind: 'thinking', text: thinking.data.thinking })
          } else if (use.success) {
            const toolDetail = detail(use.data.name, use.data.input, cwd)
            events.push({
              kind: 'tool_start',
              callId: use.data.id,
              tool: use.data.name,
              preview: preview(use.data.name, use.data.input),
              ...(toolDetail ? { detail: toolDetail } : {}),
            })
          } else if (result.success) {
            events.push({
              kind: 'tool_end',
              callId: result.data.tool_use_id,
              ok: result.data.is_error !== true,
              preview: resultText(result.data.content),
            })
          } else {
            stats.unknown++
            // A block of a known kind that fails its schema, or one nobody allow-listed, may have been the answer or a
            // tool outcome. (Text and thinking inside a user message are echoes: nothing depends on them.)
            const kind = ContentBlock.safeParse(block)
            const type = kind.success ? kind.data.type : ''
            const echo = message.data.type === 'user' && (type === 'text' || type === 'thinking')
            if (!echo && !IGNORABLE_BLOCKS.has(type))
              lose('Claude Code sent a record Score could not validate')
          }
        }
        return events
      }
      const result = ResultEvent.safeParse(value)
      if (result.success) {
        const usage = result.data.usage
        if (usage) {
          events.push({
            kind: 'usage',
            inputTokens:
              (usage.input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0),
            outputTokens: usage.output_tokens ?? 0,
            ...(result.data.total_cost_usd !== undefined
              ? { costUsd: result.data.total_cost_usd }
              : {}),
          })
        }
        const failed =
          result.data.is_error === true || (result.data.subtype ?? 'success') !== 'success'
        // 7.7a §6: explicit success only. A missing subtype or is_error never implies it, and the reply must be text.
        const explicit =
          result.data.subtype === 'success' &&
          result.data.is_error === false &&
          typeof result.data.result === 'string' &&
          result.data.result.trim().length > 0
        events.push({
          kind: 'result',
          verdict: explicit
            ? { eligible: true, reply: result.data.result!, reason: null }
            : {
                eligible: false,
                reply: null,
                reason: failed
                  ? 'Claude Code reported an error'
                  : 'Claude Code did not report an explicit success with text',
              },
          ok: !failed,
          ...(result.data.result ? { text: result.data.result } : {}),
          ...(failed
            ? {
                error:
                  result.data.result || `Claude Code stopped (${result.data.subtype ?? 'error'})`,
              }
            : {}),
        })
        return events
      }
      // Known envelope without meaning for us: only the allow-listed notices (and non-init system records, hooks…) may be
      // ignored. A `result` that failed validation is exactly what must not vanish.
      stats.unknown++
      if (!IGNORABLE_RECORDS.has(envelopeType) && envelopeType !== 'system')
        lose('Claude Code sent a record Score could not validate')
      return events
    },
  }
}

/** Secret files nobody wants an agent to read, wherever they are. */
// `//` roots a pattern at the file system: a relative one would not reach parent folders or other projects.
// `.env*` covers .env, .env.local, .envrc and other suffixes.
const DENY_FILE_PATTERNS = ['//**/.env*']

/**
 * What Claude Code may never read or write, whatever the permission level (review 2026-10-09, 7.2 #1b): the folders
 * Score is told are off limits (its own home, the Hermes home, ~/.ssh; `//` is Claude's absolute-path syntax) and
 * `.env` files.
 */
export function claudeDenyRules(
  denyPaths: readonly string[],
  denyFiles: readonly string[] = [],
): string[] {
  const folders = [...new Set(denyPaths)].map((folder) => `/${folder.replace(/\/+$/, '')}/**`)
  const files = denyFiles.map((file) => `/${file}`)
  return ['Read', 'Edit'].flatMap((tool) =>
    [...folders, ...files, ...DENY_FILE_PATTERNS].map((pattern) => `${tool}(${pattern})`),
  )
}

// Shell use at `workspace-write`: only read-only git queries. Everything else a shell could do is refused by the CLI.
const WORKSPACE_ALLOWED = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(ls:*)',
]

export const claudeDriver: CodingDriver = {
  runtime: 'claude-code',
  resumeRefusal: /^No conversation found with session ID\b/i,
  label: 'Claude Code',
  executable: 'claude',
  testedVersions: ['2.1.295'],
  supported: true,
  quota: 'Uses your Claude plan quota (the CLI’s own login).',
  promptVia: 'stdin',
  verifiedPermissions: ['read-only', 'workspace-write', 'full'],
  warning: null,
  requiresReadAck: () => false,
  parseVersion(output) {
    return /^(\d+\.\d+\.\d+)\b.*Claude Code/m.exec(output.trim())?.[1] ?? null
  },
  buildArgs(options: DriverRunOptions) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    // Never answer a permission prompt: what the mode doesn't allow is refused.
    args.push('--permission-prompts', 'none')
    switch (options.permission) {
      case 'read-only':
        // Only the reading tools exist at all; dontAsk refuses anything else.
        args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob')
        break
      case 'workspace-write':
        args.push(
          '--permission-mode',
          'acceptEdits',
          '--allowed-tools',
          WORKSPACE_ALLOWED.join(','),
        )
        break
      case 'full':
        args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions')
        break
    }
    if (options.settingsPath) args.push('--settings', options.settingsPath)
    args.push('--disallowed-tools', claudeDenyRules(options.denyPaths, options.denyFiles).join(','))
    if (options.model) args.push('--model', options.model)
    if (options.sessionId) args.push('--resume', options.sessionId)
    return args
  },
  createParser: (options) => createClaudeParser(options.cwd),
  settingsFile(denyPaths, denyFiles) {
    return {
      name: 'claude-settings.json',
      content: JSON.stringify(
        { permissions: { deny: claudeDenyRules(denyPaths, denyFiles) } },
        null,
        2,
      ),
    }
  },
}

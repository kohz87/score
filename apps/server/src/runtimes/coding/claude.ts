import type { CodingQuotaWindow } from '@score/contract'
import { claudeQuotaFromRecord } from './quota.ts'
import { withBounds } from './note.ts'
import { z } from 'zod'
import { redact } from '../../redact.ts'
import { join } from 'node:path'
import { inRoots } from './worker-sources.ts'
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
// System records that are notices (hooks, a retried request, status). Validated: a known subtype that reports an error,
// an unknown subtype, or any system record after the result could be the failure that contradicts the verdict (FV #3).
const IGNORABLE_SYSTEM = new Set([
  'hook_started',
  'hook_response',
  // Sent by Claude Code 2.x right after init, before the answer (seen in a real read-only turn, 2026-10-13).
  'commands_changed',
  'hook_progress',
  'api_retry',
  'status',
  'compact_boundary',
])
const SystemNotice = z.object({
  type: z.literal('system'),
  subtype: z.string().min(1),
  is_error: z.boolean().optional(),
})
// Sub-agent records (Claude Code 2.1.302, real capture 2026-10-17). Exactly the captured shapes; a record that does not
// match falls through to the system-notice rule and is loss. They describe the sub-agent only, never the turn.
const Count = z.number().finite().nonnegative()
const SubUsage = z.object({ total_tokens: Count, tool_uses: Count, duration_ms: Count }).loose()
const TaskStarted = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  description: z.string(),
  subagent_type: z.string().optional(),
  is_error: z.boolean().optional(),
})
const TaskProgress = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_progress'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  usage: SubUsage,
  is_error: z.boolean().optional(),
})
const TaskUpdated = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string().min(1),
  patch: z.object({ status: z.string().min(1).optional() }).loose(),
  is_error: z.boolean().optional(),
})
const TaskNotification = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  status: z.string().min(1),
  usage: SubUsage.optional(),
  is_error: z.boolean().optional(),
})
// Only `completed` is a clean end; a status Score has not seen reads as failed for the sub-agent (visible, not the turn).
const subStatus = (status: string): 'running' | 'done' | 'failed' =>
  status === 'completed'
    ? 'done'
    : status === 'running' || status === 'pending'
      ? 'running'
      : 'failed'
const IGNORABLE_BLOCKS = new Set(['image', 'redacted_thinking', 'document'])

const PATH_KEYS = ['file_path', 'path', 'notebook_path']
function preview(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const pick = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null)
  if (tool === 'Bash') return pick('command') ?? ''
  // A sub-agent's card says what it was asked to do, in a few words, not the whole prompt (PLAN 8.7).
  if (tool === 'Agent' || tool === 'Task') {
    const description = pick('description')
    if (description) return description
  }
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
  let resultSeen = false
  // task_updated names the task, not the Agent tool call: remembered from the other task_* records.
  const taskCalls = new Map<string, string>()
  // The latest rate-limit windows of the stream (8.1): kept for the meters, never part of a verdict.
  let quota: CodingQuotaWindow[] | null = null
  const subagentEvent = (value: unknown): CodingEvent | null => {
    const started = TaskStarted.safeParse(value)
    if (started.success && started.data.is_error !== true) {
      taskCalls.set(started.data.task_id, started.data.tool_use_id)
      return {
        kind: 'subagent',
        callId: started.data.tool_use_id,
        status: 'running',
        description: started.data.description,
        ...(started.data.subagent_type ? { subagentType: started.data.subagent_type } : {}),
      }
    }
    const progress = TaskProgress.safeParse(value)
    if (progress.success && progress.data.is_error !== true) {
      taskCalls.set(progress.data.task_id, progress.data.tool_use_id)
      return {
        kind: 'subagent',
        callId: progress.data.tool_use_id,
        status: 'running',
        toolCalls: progress.data.usage.tool_uses,
        durationMs: progress.data.usage.duration_ms,
        totalTokens: progress.data.usage.total_tokens,
      }
    }
    const note = TaskNotification.safeParse(value)
    if (note.success && note.data.is_error !== true) {
      taskCalls.set(note.data.task_id, note.data.tool_use_id)
      const usage = note.data.usage
      return {
        kind: 'subagent',
        callId: note.data.tool_use_id,
        status: subStatus(note.data.status),
        ...(usage
          ? {
              toolCalls: usage.tool_uses,
              durationMs: usage.duration_ms,
              totalTokens: usage.total_tokens,
            }
          : {}),
      }
    }
    const updated = TaskUpdated.safeParse(value)
    const callId = updated.success ? taskCalls.get(updated.data.task_id) : undefined
    // An update for a task Score never saw start cannot be placed: it stays unrecognised (loss).
    if (updated.success && updated.data.is_error !== true && callId) {
      const status = updated.data.patch.status
      return { kind: 'subagent', callId, status: status ? subStatus(status) : 'running' }
    }
    return null
  }
  return {
    stats,
    quota: () => quota,
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
        const rawParent = (value as { parent_tool_use_id?: unknown }).parent_tool_use_id
        const parent = typeof rawParent === 'string' && rawParent ? rawParent : undefined
        // Anything the model or its tools did after the result contradicts the verdict already given (A2).
        if (resultSeen && (typeof content === 'string' ? content !== '' : content.length > 0))
          lose('Claude Code reported activity after its result')
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
          // A sub-agent's own prose is its report to the Agent tool, not part of the turn's reply.
          if (parent && (text.success || thinking.success) && message.data.type === 'assistant')
            continue
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
              ...(parent ? { parentCallId: parent } : {}),
              tool: use.data.name,
              preview: preview(use.data.name, use.data.input),
              ...(toolDetail ? { detail: toolDetail } : {}),
            })
          } else if (result.success) {
            events.push({
              kind: 'tool_end',
              callId: result.data.tool_use_id,
              ...(parent ? { parentCallId: parent } : {}),
              ok: result.data.is_error !== true,
              preview: resultText(result.data.content),
            })
          } else {
            // A block of a known kind that fails its schema, or one nobody allow-listed, may have been the answer or a
            // tool outcome. (Text and thinking inside a user message are echoes: nothing depends on them.)
            const kind = ContentBlock.safeParse(block)
            const type = kind.success ? kind.data.type : ''
            const echo = message.data.type === 'user' && (type === 'text' || type === 'thinking')
            if (!echo) stats.unknown++
            if (!echo && !IGNORABLE_BLOCKS.has(type))
              lose('Claude Code sent a record Score could not validate')
          }
        }
        return events
      }
      const result = ResultEvent.safeParse(value)
      if (result.success) {
        // One terminal per attempt (re-review 6 #1): a second result, success or not, is loss and never replaces the first.
        if (resultSeen) {
          lose('Claude Code reported more than one result')
          return events
        }
        resultSeen = true
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
      if (envelopeType === 'rate_limit_event') {
        const windows = claudeQuotaFromRecord(value)
        quota = windows ?? quota
        // A record that carries windows is understood; an odd one still counts.
        if (windows) return events
      }
      if (envelopeType === 'system' && !resultSeen) {
        const sub = subagentEvent(value)
        if (sub) {
          events.push(sub)
          return events
        }
        if ((value as { subtype?: unknown }).subtype === 'commands_changed') return events
      }
      // Known envelope without meaning for us: only the allow-listed notices (and non-init system records, hooks…) may be
      // ignored. A `result` that failed validation is exactly what must not vanish.
      stats.unknown++
      if (envelopeType === 'system') {
        const notice = SystemNotice.safeParse(value)
        if (
          !notice.success ||
          !IGNORABLE_SYSTEM.has(notice.data.subtype) ||
          notice.data.is_error === true ||
          resultSeen
        )
          lose('Claude Code sent a system record that Score could not rule out as a failure')
      } else if (!IGNORABLE_RECORDS.has(envelopeType))
        lose('Claude Code sent a record Score could not validate')
      return events
    },
  }
}

/** Secret files nobody wants an agent to read, wherever they are. */
// `//` roots a pattern at the file system: a relative one would not reach parent folders or other projects.
// `.env*` covers .env, .env.local, .envrc and other suffixes.
const DENY_FILE_PATTERNS = ['//**/.env*']

const CLAUDE_DENY_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit'] as const

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
  // Claude Code applies Read rules to Grep/Glob and Edit rules to Write/NotebookEdit; every tool is listed anyway.
  return CLAUDE_DENY_TOOLS.flatMap((tool) =>
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
  // 2.1.296: real read-only turns on 2026-10-13 (7.7a live check; captured record shapes in coding-drivers.test.ts), owner
  // decision 77.
  // 2.1.301: real read-only turn on 2026-10-16 (owner-approved), record shapes unchanged. 2.1.302: a read-only turn and a
  // workspace-write turn with a sub-agent on 2026-10-17 (decision 95), both replayed without loss.
  testedVersions: ['2.1.295', '2.1.296', '2.1.301', '2.1.302'],
  supported: true,
  quota: 'Uses your Claude plan quota (the CLI’s own login).',
  promptVia: 'stdin',
  instructions: 'file',
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
    // A worker uses no MCP server the person configured for their own sessions (7.7b §3).
    if (options.worker) args.push('--strict-mcp-config')
    args.push('--disallowed-tools', claudeDenyRules(options.denyPaths, options.denyFiles).join(','))
    if (options.model) args.push('--model', options.model)
    if (options.sessionId) args.push('--resume', options.sessionId)
    // The owner's role and instructions (PLAN 8.8): a file, never the text on argv. Claude Code records the system prompt
    // once per conversation, so a resumed session renders it fresh for an edit to apply (`claude --help`, 2.1.301).
    if (options.instructionsFile) args.push('--append-system-prompt-file', options.instructionsFile)
    if (options.refreshSystemPrompt) args.push('--system-prompt-snapshot', 'off')
    return args
  },
  worker: {
    // Checked against `claude --help` of 2.1.296 (the installed CLI, 2026-10-13); 2.1.295 is the pinned test version.
    // 2.1.302: `--strict-mcp-config` and `--setting-sources` help text identical to 2.1.301 (2026-10-18).
    versions: ['2.1.295', '2.1.296', '2.1.301', '2.1.302'],
    neutralised: [
      {
        source: 'MCP servers (user, project, local and managed)',
        flag: '--strict-mcp-config',
        evidence:
          '"--strict-mcp-config  Only use MCP servers from --mcp-config, ignoring all other MCP configurations" (no --mcp-config is passed)',
      },
    ],
    // `--setting-sources` is documented ("Comma-separated list of setting sources to load (user, project, local)"), but the
    // help does not say what an empty list does, so the settings sources are bound by identity instead of switched off.
    bound: ({ home, workspace, env }) => {
      const config = env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude')
      return [
        join(config, 'settings.json'),
        join(config, 'CLAUDE.md'),
        ...inRoots(workspace, '.claude', 'settings.json'),
        ...inRoots(workspace, '.claude', 'settings.local.json'),
        ...inRoots(workspace, 'CLAUDE.md'),
        ...inRoots(workspace, 'CLAUDE.local.md'),
        ...inRoots(workspace, '.claude', 'CLAUDE.md'),
        '/etc/claude-code/managed-settings.json',
        '/etc/claude-code/CLAUDE.md',
      ]
    },
    reach: (permission, workspace) =>
      permission === 'read-only'
        ? {
            text: `Reads files in ${workspace}. It can’t change files, run commands or use the network.`,
            beyondWorkspace: false,
          }
        : {
            text: `Reads and edits files in ${workspace}, and runs read-only git commands and ls there. Anything else it tries is refused.`,
            beyondWorkspace: false,
          },
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

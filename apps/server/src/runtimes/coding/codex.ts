import { z } from 'zod'
import type { CodingDriver, CodingEvent, DriverRunOptions, LineParser } from './types.ts'

// Codex CLI, headless: `codex exec --json`. Event shapes follow OpenAI's documented JSONL stream
// (thread.started, item.started/completed, turn.completed/failed). Anything else is counted and dropped.

const Envelope = z.object({ type: z.string() }).loose()
const ThreadStarted = z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) })
const TurnCompleted = z.object({
  type: z.literal('turn.completed'),
  usage: z
    .object({
      input_tokens: z.number().finite().nonnegative().optional(),
      cached_input_tokens: z.number().finite().nonnegative().optional(),
      output_tokens: z.number().finite().nonnegative().optional(),
    })
    .loose()
    .optional(),
})
const TurnFailed = z.object({
  type: z.literal('turn.failed'),
  error: z.object({ message: z.string() }).partial().optional(),
})
const ItemEvent = z.object({
  type: z.enum(['item.started', 'item.updated', 'item.completed']),
  item: z.object({ id: z.string().min(1), type: z.string() }).loose(),
})
const CommandItem = z.object({
  command: z.string(),
  aggregated_output: z.string().optional(),
  exit_code: z.number().int().nullish(),
  status: z.string().optional(),
})
const MessageItem = z.object({ text: z.string() })
const FileItem = z.object({
  changes: z.array(
    z.object({ path: z.string().min(1), kind: z.enum(['add', 'delete', 'update']) }),
  ),
  status: z.string().optional(),
})
const McpItem = z.object({
  server: z.string().optional(),
  tool: z.string(),
  status: z.string().optional(),
})
const SearchItem = z.object({ query: z.string() })

/** Whether a decoded record says it is a completed or updated agent message, whatever else is wrong with it. */
function claimsAgentMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { type, item } = value as { type?: unknown; item?: unknown }
  if (type !== 'item.completed' && type !== 'item.updated') return false
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'agent_message'
  )
}

export function createCodexParser(cwd?: string): LineParser {
  const stats = { unknown: 0, malformed: 0 }
  let spoke = false
  // 7.7a §6: every agent_message is validated; a malformed or empty completed one invalidates authority for the turn.
  // The reply is the last validated message before turn.completed.
  let lastMessage: string | null = null
  let messageInvalid = false
  let droppedAtTurnStart = 0
  const started = new Set<string>()
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
      if (!Envelope.safeParse(value).success) {
        stats.malformed++
        return []
      }
      // A record that claims to be an agent_message and fails the item schema (no id, wrong shape) could have been the
      // final one: the turn loses its authority before the outer validation drops it (review 2026-10-12 #3).
      if (claimsAgentMessage(value) && !ItemEvent.safeParse(value).success) messageInvalid = true
      const thread = ThreadStarted.safeParse(value)
      if (thread.success) return [{ kind: 'session', sessionId: thread.data.thread_id }]
      const completed = TurnCompleted.safeParse(value)
      if (completed.success) {
        const events: CodingEvent[] = []
        const usage = completed.data.usage
        // `input_tokens` already counts the cached share.
        if (usage)
          events.push({
            kind: 'usage',
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          })
        // Any record dropped during the turn (unparseable line) means the stream is not whole: no authority.
        const dropped = stats.malformed - droppedAtTurnStart
        const eligible = !messageInvalid && lastMessage !== null && dropped === 0
        events.push({
          kind: 'result',
          ok: true,
          verdict: eligible
            ? { eligible: true, reply: lastMessage, reason: null }
            : {
                eligible: false,
                reply: null,
                reason: messageInvalid
                  ? 'Codex sent a message Score could not validate'
                  : dropped > 0
                    ? 'Score dropped a record of this turn'
                    : 'Codex ended the turn without a final message',
              },
        })
        lastMessage = null
        messageInvalid = false
        droppedAtTurnStart = stats.malformed
        return events
      }
      const failed = TurnFailed.safeParse(value)
      if (failed.success)
        return [
          {
            kind: 'result',
            ok: false,
            error: failed.data.error?.message || 'Codex reported a failed turn',
            verdict: { eligible: false, reply: null, reason: 'Codex reported a failed turn' },
          },
        ]
      // Known, nothing to show.
      if (Envelope.parse(value).type === 'turn.started') return []
      const item = ItemEvent.safeParse(value)
      if (!item.success) {
        stats.unknown++
        return []
      }
      const { id, type } = item.data.item
      const phase = item.data.type
      if (type === 'agent_message') {
        const message = MessageItem.safeParse(item.data.item)
        if (phase === 'item.completed' && (!message.success || !message.data.text.trim()))
          messageInvalid = true
        if (phase === 'item.updated' && !message.success) messageInvalid = true
        if (phase !== 'item.completed' || !message.success || !message.data.text) return []
        lastMessage = message.data.text
        const text = spoke ? `\n\n${message.data.text}` : message.data.text
        spoke = true
        return [{ kind: 'text', text }]
      }
      if (type === 'reasoning') {
        const message = MessageItem.safeParse(item.data.item)
        return phase === 'item.completed' && message.success && message.data.text
          ? [{ kind: 'thinking', text: message.data.text }]
          : []
      }
      if (type === 'command_execution') {
        const command = CommandItem.safeParse(item.data.item)
        if (!command.success) {
          stats.unknown++
          return []
        }
        const events: CodingEvent[] = []
        if (!started.has(id)) {
          started.add(id)
          events.push({
            kind: 'tool_start',
            callId: id,
            tool: 'Bash',
            preview: command.data.command,
            detail: { type: 'command', command: command.data.command, ...(cwd ? { cwd } : {}) },
          })
        }
        if (phase === 'item.completed')
          events.push({
            kind: 'tool_end',
            callId: id,
            ok: command.data.status !== 'failed' && (command.data.exit_code ?? 0) === 0,
            preview: command.data.aggregated_output ?? '',
            exitCode: command.data.exit_code ?? null,
          })
        return events
      }
      if (type === 'file_change') {
        const change = FileItem.safeParse(item.data.item)
        if (!change.success) {
          stats.unknown++
          return []
        }
        if (phase !== 'item.completed') return []
        return change.data.changes.flatMap((entry, index): CodingEvent[] => [
          {
            kind: 'tool_start',
            callId: `${id}#${index}`,
            tool: 'Edit',
            preview: entry.path,
            detail: { type: 'file', path: entry.path, change: entry.kind },
          },
          {
            kind: 'tool_end',
            callId: `${id}#${index}`,
            ok: change.data.status !== 'failed',
            preview: `${entry.kind} ${entry.path}`,
          },
        ])
      }
      if (type === 'mcp_tool_call') {
        const call = McpItem.safeParse(item.data.item)
        if (!call.success) {
          stats.unknown++
          return []
        }
        const events: CodingEvent[] = []
        if (!started.has(id)) {
          started.add(id)
          events.push({
            kind: 'tool_start',
            callId: id,
            tool: call.data.server ? `${call.data.server}.${call.data.tool}` : call.data.tool,
            preview: '',
          })
        }
        if (phase === 'item.completed')
          events.push({
            kind: 'tool_end',
            callId: id,
            ok: call.data.status !== 'failed',
            preview: '',
          })
        return events
      }
      if (type === 'web_search') {
        const search = SearchItem.safeParse(item.data.item)
        if (phase !== 'item.completed' || !search.success) return []
        return [
          { kind: 'tool_start', callId: id, tool: 'WebSearch', preview: search.data.query },
          { kind: 'tool_end', callId: id, ok: true, preview: '' },
        ]
      }
      stats.unknown++
      return []
    },
  }
}

const SANDBOX = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  full: 'danger-full-access',
} as const

export const codexDriver: CodingDriver = {
  runtime: 'codex',
  resumeRefusal: /^(?:thread\/resume failed: )?no rollout found for thread id\b/i,
  label: 'Codex',
  executable: 'codex',
  testedVersions: ['0.160.1'],
  supported: true,
  quota: 'Uses your ChatGPT plan quota, shared with other Codex work on that account.',
  promptVia: 'stdin',
  verifiedPermissions: ['read-only', 'workspace-write', 'full'],
  warning: null,
  requiresReadAck: () => true,
  parseVersion(output) {
    return /codex-cli\s+(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
  },
  buildArgs(options: DriverRunOptions) {
    const sandbox = SANDBOX[options.permission]
    // The prompt arrives on stdin (`-`). `exec resume` has no -s/-C: it takes the sandbox as a config override and
    // works in the process's own folder (the workspace).
    if (options.sessionId) {
      const args = [
        'exec',
        'resume',
        options.sessionId,
        '--json',
        '--skip-git-repo-check',
        '-c',
        `sandbox_mode="${sandbox}"`,
        '-c',
        'approval_policy="never"',
      ]
      if (options.model) args.push('-m', options.model)
      args.push('-')
      return args
    }
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      sandbox,
      '-C',
      options.workspace,
      '-c',
      'approval_policy="never"',
    ]
    if (options.model) args.push('-m', options.model)
    args.push('-')
    return args
  },
  createParser: (options) => createCodexParser(options.cwd),
}

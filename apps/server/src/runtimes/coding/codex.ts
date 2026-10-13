import { z } from 'zod'
import { boundId, MAX_REPLY_BYTES, rememberId, withBounds } from './note.ts'
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

// Records Score knows it can ignore, named explicitly (FW #5): a notice that carries no turn content. Everything else
// that isn't understood is loss for the whole attempt, because it could have been the one that mattered.
const IGNORABLE_RECORDS = new Set(['turn.started'])
// The one `error` record that is only a notice: Codex telling the person it is retrying a dropped stream. It must be
// exactly this shape, short, and arrive before the turn ended (FV #3); any other error record reports a failure.
const ErrorNotice = z.object({ type: z.literal('error'), message: z.string().max(300) }).strict()
// The pinned CLI's retry notice is `Reconnecting... n/m`, optionally followed by the reason for the retry. Nothing
// else counts, so a fatal message that merely mentions a retry stays loss (re-review 5 #1).
const RETRY_NOTICE = /^Reconnecting\.\.\. (\d+)\/(\d+)/
function isRetryNotice(message: string): boolean {
  const match = RETRY_NOTICE.exec(message)
  if (!match) return false
  const n = Number(match[1])
  const m = Number(match[2])
  return n >= 1 && n <= m
}
const IGNORABLE_ITEMS = new Set(['todo_list'])

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
  const inner = createInnerCodexParser(cwd)
  return withBounds(inner)
}

function createInnerCodexParser(cwd?: string): LineParser & { ownBytes(): number } {
  const stats = { unknown: 0, malformed: 0 }
  let spoke = false
  // 7.7a §6: every agent_message is validated; a malformed or empty completed one invalidates authority for the turn.
  // The reply is the last validated message before turn.completed.
  let lastMessage: string | null = null
  // Sticky for the whole attempt, also after `turn.completed` (review 2026-10-12 #3): once a message or record that could
  // have been the final one was lost or invalid, nothing this attempt produced is authoritative.
  let lossNote: string | null = null
  const lose = (note: string) => {
    lossNote ??= note
  }
  const started = new Set<string>()
  // A record after `turn.completed` can't be a notice about the turn: it could contradict the verdict already given.
  let turnEnded = false
  // One terminal per attempt (re-review 6 #1): completed or failed closes the attempt; a later terminal, or a message
  // after it, contradicts the verdict and is sticky loss. A failed terminal is never replaced.
  let terminals = 0
  return {
    stats,
    ownBytes: () =>
      Buffer.byteLength(lastMessage ?? '') +
      [...started].reduce((sum, id) => sum + Buffer.byteLength(id), 0),
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
      if (!Envelope.safeParse(value).success) {
        stats.malformed++
        return []
      }
      // A record that claims to be an agent_message and fails the item schema (no id, wrong shape) could have been the
      // final one: the turn loses its authority before the outer validation drops it (review 2026-10-12 #3).
      if (claimsAgentMessage(value) && !ItemEvent.safeParse(value).success)
        lose('Codex sent a message Score could not validate')
      // Any recognised record Score rejects takes the authority of the whole attempt, terminal ones too: it could have
      // been the one that mattered (re-review 2026-10-12 #1). Decided once the stream was processed (`lossReason`).
      const recordType = Envelope.parse(value).type
      const thread = ThreadStarted.safeParse(value)
      if (thread.success) return [{ kind: 'session', sessionId: thread.data.thread_id }]
      if (recordType === 'thread.started') {
        stats.unknown++
        lose('Codex sent a record Score could not validate')
        return []
      }
      const completed = TurnCompleted.safeParse(value)
      if (!completed.success && recordType === 'turn.completed') {
        stats.unknown++
        lose('Codex sent a record Score could not validate')
        return []
      }
      if (completed.success) {
        turnEnded = true
        if (terminals++ > 0) {
          lose('Codex reported more than one end of the turn')
          return []
        }
        const events: CodingEvent[] = []
        const usage = completed.data.usage
        // `input_tokens` already counts the cached share.
        if (usage)
          events.push({
            kind: 'usage',
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          })
        // Any record dropped so far (unparseable line) means the stream is not whole: no authority. Loss that comes after
        // this record is applied once the whole stream was processed (`lossReason`).
        const lost =
          lossNote ?? (stats.malformed > 0 ? 'Score dropped a record of this turn' : null)
        const eligible = lost === null && lastMessage !== null
        events.push({
          kind: 'result',
          ok: true,
          verdict: eligible
            ? { eligible: true, reply: lastMessage, reason: null }
            : {
                eligible: false,
                reply: null,
                reason: lost ?? 'Codex ended the turn without a final message',
              },
        })
        lastMessage = null
        return events
      }
      const failed = TurnFailed.safeParse(value)
      if (!failed.success && recordType === 'turn.failed') {
        stats.unknown++
        lose('Codex sent a record Score could not validate')
        return []
      }
      if (failed.success) {
        turnEnded = true
        if (terminals++ > 0) {
          lose('Codex reported more than one end of the turn')
          return []
        }
        return [
          {
            kind: 'result',
            ok: false,
            error: failed.data.error?.message || 'Codex reported a failed turn',
            verdict: { eligible: false, reply: null, reason: 'Codex reported a failed turn' },
          },
        ]
      }
      if (recordType === 'error') {
        // An error envelope is ignorable only as a validated retry notice before the turn ended; anything else (a
        // malformed one, one after the verdict, one that reports a failure) takes the authority of the attempt.
        const notice = ErrorNotice.safeParse(value)
        stats.unknown++
        if (!notice.success || turnEnded || !isRetryNotice(notice.data.message))
          lose('Codex reported an error that Score could not rule out')
        return []
      }
      // Known, nothing to show.
      if (IGNORABLE_RECORDS.has(recordType)) return []
      const item = ItemEvent.safeParse(value)
      if (!item.success) {
        stats.unknown++
        // A record that isn't an item and isn't allow-listed, or an item record without a usable item (null, no id),
        // may have carried the final message or the failure.
        lose('Codex sent a record Score could not validate')
        return []
      }
      const { type } = item.data.item
      const id = boundId(item.data.item.id)
      const phase = item.data.type
      if (type === 'agent_message') {
        const message = MessageItem.safeParse(item.data.item)
        // Every phase is validated: a started or updated message that is malformed makes the turn non-authoritative too.
        if (!message.success) lose('Codex sent a message Score could not validate')
        else if (phase === 'item.completed' && !message.data.text.trim())
          lose('Codex sent a message Score could not validate')
        if (phase !== 'item.completed' || !message.success || !message.data.text) return []
        if (turnEnded) {
          lose('Codex sent a message after the end of the turn')
          return []
        }
        if (Buffer.byteLength(message.data.text) > MAX_REPLY_BYTES) {
          lose('Codex sent a message larger than Score keeps')
          return []
        }
        lastMessage = message.data.text
        const text = spoke ? `\n\n${message.data.text}` : message.data.text
        spoke = true
        return [{ kind: 'text', text }]
      }
      if (type === 'reasoning') {
        const message = MessageItem.safeParse(item.data.item)
        if (!message.success) lose('Codex sent a record Score could not validate')
        return phase === 'item.completed' && message.success && message.data.text
          ? [{ kind: 'thinking', text: message.data.text }]
          : []
      }
      if (type === 'command_execution') {
        const command = CommandItem.safeParse(item.data.item)
        if (!command.success) {
          stats.unknown++
          lose('Codex sent a record Score could not validate')
          return []
        }
        const events: CodingEvent[] = []
        if (!started.has(id)) {
          rememberId(started, id)
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
          lose('Codex sent a record Score could not validate')
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
          lose('Codex sent a record Score could not validate')
          return []
        }
        const events: CodingEvent[] = []
        if (!started.has(id)) {
          rememberId(started, id)
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
        if (!search.success) lose('Codex sent a record Score could not validate')
        if (phase !== 'item.completed' || !search.success) return []
        return [
          { kind: 'tool_start', callId: id, tool: 'WebSearch', preview: search.data.query },
          { kind: 'tool_end', callId: id, ok: true, preview: '' },
        ]
      }
      stats.unknown++
      if (!IGNORABLE_ITEMS.has(type)) lose('Codex sent a record Score could not validate')
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

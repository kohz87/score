import type { CodingQuotaWindow } from '@score/contract'
import { claudeQuotaFromRecord } from './quota.ts'
import { withBounds } from './note.ts'
import type { CodingEvent, LineParser } from './types.ts'
import {
  AdvisorResultBlock,
  AdvisorUseBlock,
  ContentBlock,
  Envelope,
  IGNORABLE_BLOCKS,
  IGNORABLE_RECORDS,
  IGNORABLE_SYSTEM,
  InitEvent,
  MessageEvent,
  ResultEvent,
  SystemNotice,
  TaskNotification,
  TaskProgress,
  TaskStarted,
  TaskUpdated,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './claude-schemas.ts'
import { detail, preview, resultText, subStatus, systemKind } from './claude-helpers.ts'

// Claude Code, headless: `claude -p --output-format stream-json --verbose`. Event shapes follow Anthropic's documented
// stream-json output (system/init, assistant, user, result). Parsed defensively: anything that doesn't match is counted
// and dropped, never stored raw.

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
          const advisorUse = AdvisorUseBlock.safeParse(block)
          const advisorResult = AdvisorResultBlock.safeParse(block)
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
          } else if (advisorUse.success && message.data.type === 'assistant') {
            events.push({
              kind: 'tool_start',
              callId: advisorUse.data.id,
              ...(parent ? { parentCallId: parent } : {}),
              tool: 'advisor',
              preview: 'Asked the advisor',
            })
          } else if (advisorResult.success && message.data.type === 'assistant') {
            // An error result (its type ends in _error) is a consult that failed; the turn goes on either way.
            const failed = advisorResult.data.content.type.endsWith('_error')
            events.push({
              kind: 'tool_end',
              callId: advisorResult.data.tool_use_id,
              ...(parent ? { parentCallId: parent } : {}),
              ok: !failed,
              preview: failed
                ? 'The advisor could not answer'
                : 'Advice given (only the worker can read it)',
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
            ...(result.data.ttft_ms !== undefined ? { ttftMs: result.data.ttft_ms } : {}),
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
          // 3.8.2: the record's kind (a bare identifier, never its content) names what to look at next time.
          lose(
            `Claude Code sent a system record that Score could not rule out as a failure (${systemKind(value, resultSeen)})`,
          )
      } else if (!IGNORABLE_RECORDS.has(envelopeType))
        lose('Claude Code sent a record Score could not validate')
      return events
    },
  }
}

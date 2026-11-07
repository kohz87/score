import type { DatabaseSync } from 'node:sqlite'
import { SubagentSummarySchema, type MessagePart, type SubagentSummary } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'
import { MessageRunSchema } from './message-runs-turns.ts'
import { messageFromRow, storeMessage } from './rooms.ts'

// Surfaces a Score-run approval in the room that started the run. Messages are append-only, so the
// card is its own agent message; the fixed id makes this idempotent per approval.
export function approvalMessage(
  sqlite: DatabaseSync,
  approvalId: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite
    .prepare(
      `SELECT m.room_id, m.agent_id, m.job_id, a.run_id FROM approvals a
       LEFT JOIN message_runs m ON m.run_id = a.run_id WHERE a.id = ? AND a.origin = 'score-run'`,
    )
    .get(approvalId)
  if (!value) return []
  const row = z
    .object({
      room_id: z.string().nullable(),
      agent_id: z.string().nullable(),
      job_id: z.string().nullable(),
      run_id: z.string().nullable(),
    })
    .parse(value)
  if (!row.room_id || !row.agent_id) return []
  return storeMessage(
    sqlite,
    {
      id: `approval:${approvalId}`,
      roomId: row.room_id,
      author: { kind: 'agent', agentId: row.agent_id },
      to: [],
      parts: [{ kind: 'approval', approvalId }],
      refs: row.run_id ? [{ kind: 'run', runId: row.run_id }] : [],
      streaming: false,
      createdAt: now,
      ...(row.job_id ? { jobId: row.job_id } : {}),
    },
    now,
  )
}

export function toolsSummary(tools: string[]): string | null {
  if (!tools.length) return null
  const commands = tools.filter((tool) => tool === 'terminal').length
  const files = tools.filter((tool) => ['write_file', 'patch', 'edit_file'].includes(tool)).length
  const other = tools.length - commands - files
  const parts = []
  if (commands) parts.push(`Ran ${commands} command${commands === 1 ? '' : 's'}`)
  if (files) parts.push(`${commands ? 'edited' : 'Edited'} ${files} file${files === 1 ? '' : 's'}`)
  if (other) parts.push(`${parts.length ? 'used' : 'Used'} ${other} tool${other === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

const MAX_TOOL_CARDS = 30
const MAX_THINKING_PARTS = 8
const ActivityRowSchema = z.object({
  seq: z.int(),
  tool: z.string().min(1).nullable(),
  text: z.string().nullable(),
  preview: z.string().nullable(),
  status: z.enum(['running', 'ok', 'error']).nullable(),
  result_preview: z.string().nullable(),
  call_id: z.string().nullable(),
  parent_call_id: z.string().nullable(),
  subagent: z.string().nullable(),
})

/** The stored sub-agent summary; anything unreadable is absent (PLAN 8.7). */
function readSubagent(stored: string | null): SubagentSummary | undefined {
  if (stored === null) return undefined
  try {
    const parsed = SubagentSummarySchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * The tool calls and reasoning of a run as message parts (PLAN 5.25), in the order Hermes sent them. Stored previews were
 * redacted when they arrived; they are redacted and bounded again here because the parts become the stored message.
 */
export function activityParts(
  sqlite: DatabaseSync,
  runId: string,
): { parts: MessagePart[]; overflow: boolean } {
  const rows = z.array(ActivityRowSchema).parse(
    sqlite
      .prepare(
        `SELECT seq, tool, NULL AS text, preview, status, result_preview, call_id, parent_call_id, subagent FROM tool_calls WHERE run_id = ?1
         UNION ALL SELECT seq, NULL, text, NULL, NULL, NULL, NULL, NULL, NULL FROM run_thinking WHERE run_id = ?1 ORDER BY seq`,
      )
      .all(runId),
  )
  const parts: MessagePart[] = []
  let tools = 0
  let thoughts = 0
  let overflow = false
  for (const row of rows) {
    if (row.tool && row.status) {
      if (tools >= MAX_TOOL_CARDS) {
        overflow = true
        continue
      }
      tools++
      parts.push({
        kind: 'tool',
        tool: row.tool.slice(0, 200),
        args: redactBounded(row.preview ?? '', 400),
        result: row.result_preview === null ? null : redactBounded(row.result_preview, 500),
        status: row.status,
        ...(row.call_id ? { callId: row.call_id.slice(0, 200) } : {}),
        ...(row.parent_call_id ? { parentCallId: row.parent_call_id.slice(0, 200) } : {}),
        ...(readSubagent(row.subagent) ? { subagent: readSubagent(row.subagent)! } : {}),
      })
    } else if (row.text && thoughts < MAX_THINKING_PARTS) {
      thoughts++
      parts.push({ kind: 'thinking', text: redactBounded(row.text, 4096) })
    }
  }
  return { parts, overflow }
}

/**
 * The tool cards and reasoning of a reply that is still being written (PLAN 5.39), as the `message.updated` the browser
 * replaces the message's parts with. They are what completion stores in front of the text, so the card that appears here
 * stays where it is when the reply ends. Nothing is stored now: the final parts are written by `completeRunMessage`.
 */
export function liveActivityDraft(sqlite: DatabaseSync, runId: string): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'active' || mapping.purpose === 'summary') return []
  const message = messageFromRow(
    sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(mapping.message_id),
  )
  if (!message.streaming) return []
  const { parts } = activityParts(sqlite, runId)
  if (parts.length === 0) return []
  return [
    {
      type: 'message.updated',
      data: {
        roomId: mapping.room_id,
        messageId: message.id,
        parts: [...parts, ...message.parts.filter((part) => part.kind === 'text')],
      },
    },
  ]
}

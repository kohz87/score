import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redact, redactBounded } from '../redact.ts'
import { parseMessage } from './parse.ts'
import { decideHandoffs, messageTurnId } from './routing.ts'
import { messageFromRow, storeMessage, updateMessage } from './rooms.ts'

export const MessageRunSchema = z.object({
  message_id: z.string(),
  run_id: z.string().nullable(),
  room_id: z.string(),
  agent_id: z.string(),
  chain_id: z.string(),
  hop: z.int().nonnegative(),
  turn_id: z.string(),
  parent_message_id: z.string(),
  from_agent_id: z.string().nullable(),
  input: z.string(),
  admission_input: z.string().nullable(),
  model: z.string().nullable(),
  agents: z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value))),
  state: z.enum(['pending', 'active', 'completed', 'failed']),
  created_at: z.iso.datetime(),
})
export type MessageRun = z.infer<typeof MessageRunSchema>

export function reserveMessageRun(
  sqlite: DatabaseSync,
  req: {
    parentMessageId: string
    roomId: string
    agentId: string
    chainId: string
    hop: number
    input: string
    agents: string[]
    model?: string
    fromAgentId?: string
  },
  now: string,
): void {
  const turnId = messageTurnId(req.parentMessageId, req.agentId)
  sqlite
    .prepare(
      `INSERT INTO message_runs
    (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, from_agent_id, input, model, agents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(
      `reply:${turnId}`,
      req.roomId,
      req.agentId,
      req.chainId,
      req.hop,
      turnId,
      req.parentMessageId,
      req.fromAgentId ?? null,
      redact(req.input),
      req.model ?? null,
      JSON.stringify(req.agents),
      now,
    )
}

export function attachRunMessage(
  sqlite: DatabaseSync,
  turnId: string,
  runId: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(turnId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.run_id !== null) return []
  sqlite
    .prepare("UPDATE message_runs SET run_id = ?, state = 'active' WHERE turn_id = ?")
    .run(runId, turnId)
  const drafts = storeMessage(
    sqlite,
    {
      id: mapping.message_id,
      roomId: mapping.room_id,
      author: { kind: 'agent', agentId: mapping.agent_id },
      to: [],
      parts: [],
      refs: [{ kind: 'run', runId }],
      streaming: true,
      createdAt: now,
    },
    now,
  )
  if (mapping.from_agent_id)
    drafts.push({
      type: 'handoff.created',
      data: {
        briefId: null,
        handoff: {
          id: turnId,
          from: { agentId: mapping.from_agent_id, blockId: mapping.parent_message_id },
          to: { agentId: mapping.agent_id, blockId: mapping.message_id },
          kind: 'handoff',
          at: now,
        },
      },
    })
  return drafts
}

export function appendRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  append: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  return updateMessage(sqlite, mapping.room_id, mapping.message_id, redact(append), now)
}

// Surfaces a Score-run approval in the room that started the run. Messages are append-only, so the
// card is its own agent message; the fixed id makes this idempotent per approval.
export function approvalMessage(
  sqlite: DatabaseSync,
  approvalId: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite
    .prepare(
      `SELECT m.room_id, m.agent_id, a.run_id FROM approvals a
       LEFT JOIN message_runs m ON m.run_id = a.run_id WHERE a.id = ? AND a.origin = 'score-run'`,
    )
    .get(approvalId)
  if (!value) return []
  const row = z
    .object({
      room_id: z.string().nullable(),
      agent_id: z.string().nullable(),
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

export function completeRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  now: string,
  { output, handoffs = true }: { output?: string | null; handoffs?: boolean } = {},
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'active') return []
  const message = messageFromRow(
    sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(mapping.message_id),
  )
  const drafts: DomainEventDraft[] = []
  // Polling/recovery may only have the final output. Never duplicate text already streamed.
  if (!message.parts.some((part) => part.kind === 'text') && output) {
    drafts.push(...appendRunMessage(sqlite, runId, redactBounded(output, 8192), now))
    message.parts.push({ kind: 'text', text: redactBounded(output, 8192) })
  }
  const tools = z
    .array(z.object({ tool: z.string() }))
    .parse(sqlite.prepare('SELECT tool FROM tool_calls WHERE run_id = ? ORDER BY seq').all(runId))
  const summary = toolsSummary(tools.map(({ tool }) => tool))
  if (summary) message.parts.push({ kind: 'tools', summary, runId })
  if (handoffs) {
    const text = message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => redact(part.text))
      .join('\n')
    const edges = z
      .array(z.object({ from: z.string(), to: z.string() }))
      .parse(
        sqlite
          .prepare(
            'SELECT from_agent_id AS "from", agent_id AS "to" FROM message_runs WHERE chain_id = ? AND hop > 0',
          )
          .all(mapping.chain_id),
      )
    const decision = decideHandoffs({
      from: mapping.agent_id,
      mentions: parseMessage(text, mapping.agents).mentions,
      hop: mapping.hop,
      edges,
    })
    // The contract currently has no system message part; keep the visible notice as text.
    if (decision.stopped) message.parts.push({ kind: 'text', text: 'Hand-off limit reached' })
    for (const agentId of decision.targets)
      reserveMessageRun(
        sqlite,
        {
          parentMessageId: message.id,
          roomId: mapping.room_id,
          agentId,
          chainId: mapping.chain_id,
          hop: mapping.hop + 1,
          input: text,
          agents: mapping.agents,
          fromAgentId: mapping.agent_id,
        },
        now,
      )
  }
  sqlite
    .prepare('UPDATE messages SET parts = ? WHERE id = ?')
    .run(JSON.stringify(message.parts), message.id)
  sqlite.prepare("UPDATE message_runs SET state = 'completed' WHERE message_id = ?").run(message.id)
  return [...drafts, ...updateMessage(sqlite, mapping.room_id, message.id, null, now)]
}

export function roomRunInput(
  sqlite: DatabaseSync,
  roomId: string,
  input: string,
  parentMessageId: string,
): string {
  const messages = sqlite
    .prepare(
      'SELECT * FROM messages WHERE room_id = ? AND id != ? ORDER BY created_at DESC, id DESC LIMIT 10',
    )
    .all(roomId, parentMessageId)
    .map(messageFromRow)
    .reverse()
  const context = redactBounded(
    messages
      .map(
        (message) =>
          `${message.author.kind === 'you' ? 'you' : message.author.agentId}: ${message.parts
            .filter((part) => part.kind === 'text')
            .map((part) => redact(part.text))
            .join('\n')}`,
      )
      .join('\n'),
    8192,
  )
  return context ? `${input}\n\nRoom context:\n${context}` : input
}

export function failMessageRun(
  sqlite: DatabaseSync,
  turnId: string,
  code: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(turnId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'pending') return []
  sqlite.prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ?").run(turnId)
  // The contract has no system part; a short text notice from the agent explains the silence.
  return storeMessage(
    sqlite,
    {
      id: mapping.message_id,
      roomId: mapping.room_id,
      author: { kind: 'agent', agentId: mapping.agent_id },
      to: [],
      parts: [{ kind: 'text', text: `Couldn't start this agent (${code}).` }],
      createdAt: now,
      streaming: false,
      refs: [],
    },
    now,
  )
}

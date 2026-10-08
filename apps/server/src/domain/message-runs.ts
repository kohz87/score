import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redact, redactBounded } from '../redact.ts'
import { parseMessage } from './parse.ts'
import { decideHandoffs, messageTurnId } from './routing.ts'
import { messageFromRow, storeMessage, updateMessage } from './rooms.ts'
import { parsePlanSteps, planPart } from './plan.ts'

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
  pending: z.string(),
  plan_first: z.int().min(0).max(1),
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
    planFirst?: boolean
  },
  now: string,
): void {
  assertAgentAdmits(sqlite, req.agentId)
  const turnId = messageTurnId(req.parentMessageId, req.agentId)
  sqlite
    .prepare(
      `INSERT INTO message_runs
    (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, from_agent_id, input, model, agents, created_at, plan_first)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
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
      // The person's instruction is kept verbatim (the adapter strips the gateway key); agent text is redacted by callers.
      req.input,
      req.model ?? null,
      JSON.stringify(req.agents),
      now,
      req.planFirst ? 1 : 0,
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
        briefId: sqlite.prepare('SELECT id FROM briefs WHERE id = ?').get(mapping.chain_id)
          ? mapping.chain_id
          : null,
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

// Redaction matches whole patterns, but a run streams text in arbitrary chunks: a token, or a label and its value
// ("Authorization: Bearer" + "eyJ…", "api_key:" + value, a private key over many chunks), can arrive split. Text a
// later chunk could still turn into a secret is held back (not stored in the message, not emitted) until it settles
// or the run completes. The held text is sealed with a per-process key so raw fragments never sit on disk; after a
// restart it can't be opened and is dropped (at worst the last words of an interrupted reply).
const MAX_HELD = 8192
const SECRET_CONTEXT =
  /(?:[=:]|\b(?:authorization|bearer|basic|key|token|secret|password|passwd))["']?\s*$/i
const OPEN_QUOTE = /[=:]\s*(["'])(?:(?!\1)[^\n])*$/
const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1

/** How much of `text` no later chunk can change: the rest stays held. */
export function settledLength(text: string): number {
  let cut = 0
  for (let index = text.length - 1; index >= 0; index--)
    if (/\s/.test(text[index]!)) {
      cut = index + 1
      break
    }
  // A label that a value may still follow holds its whole line back.
  const from = Math.max(0, cut - 200)
  const context = SECRET_CONTEXT.exec(text.slice(from, cut))
  if (context) cut = Math.min(cut, lineStart(text, from + context.index))
  if (OPEN_QUOTE.test(text.slice(lineStart(text, cut), cut))) cut = lineStart(text, cut)
  // An unterminated PEM block holds everything from its start.
  const begin = text.lastIndexOf('-----BEGIN')
  if (begin !== -1 && !/-----END [A-Z0-9 ]+-----/.test(text.slice(begin)))
    cut = Math.min(cut, lineStart(text, begin))
  return text.length - cut > MAX_HELD ? text.length : cut
}

const SEAL_KEY = randomBytes(32)
function seal(text: string): string {
  if (!text) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}
// null: sealed by an earlier process, so it can't be opened.
function unseal(value: string): string | null {
  if (!value) return ''
  try {
    const raw = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
// "!" marks a reply whose held text was lost to a restart: later chunks then leave an interior gap that only the
// run's final output can repair. "!" is not base64, so it can't collide with sealed text.
const LOST = '!'
function readPending(value: string): { text: string; lost: boolean } {
  const lost = value.startsWith(LOST)
  const text = unseal(lost ? value.slice(1) : value)
  return { text: text ?? '', lost: lost || text === null }
}
const writePending = (text: string, lost: boolean) => (lost ? LOST : '') + seal(text)

export function appendRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  append: string,
  now: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  const held = readPending(mapping.pending)
  const text = held.text + append
  const cut = settledLength(text)
  sqlite
    .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
    .run(writePending(text.slice(cut), held.lost), mapping.message_id)
  return cut > 0
    ? updateMessage(sqlite, mapping.room_id, mapping.message_id, redact(text.slice(0, cut)), now)
    : []
}

function flushHeld(sqlite: DatabaseSync, mapping: MessageRun, now: string): DomainEventDraft[] {
  if (!mapping.pending) return []
  const held = readPending(mapping.pending).text
  sqlite
    .prepare("UPDATE message_runs SET pending = '' WHERE message_id = ?")
    .run(mapping.message_id)
  return held ? updateMessage(sqlite, mapping.room_id, mapping.message_id, redact(held), now) : []
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

function failureNotice(status: string, error: string | null | undefined): string {
  const detail = error ? `: ${redactBounded(error, 300)}` : ''
  if (status === 'cancelled') return 'This run was stopped.'
  if (status === 'interrupted') return `This run was interrupted${detail}`
  return `This run failed${detail}`
}

export function completeRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  now: string,
  {
    output,
    handoffs = true,
    status = 'completed',
    error,
  }: { output?: string | null; handoffs?: boolean; status?: string; error?: string | null } = {},
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'active') return []
  // Nothing can extend the held text any more.
  const lostHeld = readPending(mapping.pending).lost
  const drafts: DomainEventDraft[] = flushHeld(sqlite, mapping, now)
  const message = messageFromRow(
    sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(mapping.message_id),
  )
  // Polling/recovery may only have the final output. Never duplicate text already streamed, but when streaming stopped
  // short (a restart, a lost replay) and the final output continues what was streamed, append the rest: plan parsing and
  // hand-offs below must see the whole reply ("… @reviewer please check" can come after the cut; audit 2026-10-08).
  if (output) {
    const text = redactBounded(output, 8192)
    const streamed = message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('')
    // Held text lost to a restart leaves an interior gap, so the streamed text is no prefix of the output: the
    // authoritative output then replaces it (hand-offs after the gap would otherwise be missed). Without a
    // known loss a differing output is just a different summary and the streamed text stays.
    if (lostHeld && streamed && !text.startsWith(streamed) && !streamed.startsWith(text))
      message.parts = [
        { kind: 'text', text },
        ...message.parts.filter((part) => part.kind !== 'text'),
      ]
    const rest = !streamed ? text : text.startsWith(streamed) ? text.slice(streamed.length) : ''
    if (rest) {
      drafts.push(...updateMessage(sqlite, mapping.room_id, message.id, rest, now))
      const last = message.parts.findLast((part) => part.kind === 'text')
      if (last?.kind === 'text') last.text += rest
      else message.parts.push({ kind: 'text', text: rest })
    }
  }
  // Each chunk was redacted as it settled; redact the whole text once more in case a pattern spans chunks.
  message.parts = message.parts.map((part) =>
    part.kind === 'text' ? { ...part, text: redact(part.text) } : part,
  )
  // A run that did not complete would otherwise end as an empty or truncated bubble with no explanation.
  if (status !== 'completed')
    message.parts.push({ kind: 'text', text: failureNotice(status, error) })
  const tools = z
    .array(z.object({ tool: z.string() }))
    .parse(sqlite.prepare('SELECT tool FROM tool_calls WHERE run_id = ? ORDER BY seq').all(runId))
  const summary = toolsSummary(tools.map(({ tool }) => tool))
  if (summary) message.parts.push({ kind: 'tools', summary, runId })
  // A plan-first turn only proposes: the checklist becomes a plan part, and nothing is handed off until the
  // person presses Start plan.
  if (mapping.plan_first) {
    const text = message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('\n')
    const plan = planPart(mapping.chain_id, parsePlanSteps(text, mapping.agents), now)
    if (plan) message.parts.push(plan)
  } else if (handoffs) {
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
    for (const agentId of decision.targets.filter((id) => agentAdmits(sqlite, id)))
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
import { agentAdmits, assertAgentAdmits } from './agent-lifecycle.ts'

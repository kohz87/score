import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SessionCost } from '../../domain/spend.ts'
import { parseJson, readBatch, readByIds, TailInputSchema, type JsonValue } from './sqlite.ts'

const TextSchema = z.string().nullable()
const MessageRowSchema = z.object({
  id: z.int().positive(),
  session_id: z.string(),
  role: z.string(),
  content: TextSchema,
  tool_call_id: TextSchema,
  tool_calls: TextSchema,
  tool_name: TextSchema,
  timestamp: z.number(),
  active: z.union([z.literal(0), z.literal(1)]),
  compacted: z.union([z.literal(0), z.literal(1)]),
  message_uid: TextSchema,
  tool_call_uid: TextSchema,
})
export const SessionSchema = z.object({
  id: z.string(),
  source: z.string(),
  profile_name: TextSchema,
  model: TextSchema,
  title: TextSchema,
  started_at: z.number(),
  ended_at: z.number().nullable(),
  end_reason: TextSchema,
  message_count: z.int().nullable(),
  tool_call_count: z.int().nullable(),
  input_tokens: z.int().nullable(),
  output_tokens: z.int().nullable(),
  cache_read_tokens: z.int().nullable(),
  cache_write_tokens: z.int().nullable(),
  reasoning_tokens: z.int().nullable(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
  last_activity_at: z.number().nullable(),
  parent_session_id: TextSchema,
})

export type Message = Omit<z.infer<typeof MessageRowSchema>, 'tool_calls'> & {
  tool_calls: JsonValue
}
export type Session = z.infer<typeof SessionSchema>

export function tailMessages(db: DatabaseSync, input: z.input<typeof TailInputSchema>) {
  const { afterId, limit } = TailInputSchema.parse(input)
  const batch = readBatch(
    db,
    'messages',
    MessageRowSchema,
    'WHERE id > ? ORDER BY id LIMIT ?',
    [afterId, limit],
    true,
  )
  let malformed = batch.malformed
  const rows: Message[] = batch.rows.map((row) => {
    const toolCalls = parseJson(row.tool_calls)
    malformed += toolCalls.malformed
    return { ...row, tool_calls: toolCalls.value }
  })
  return { ...batch, rows, malformed }
}

export function readSessions(db: DatabaseSync, ids: string[]) {
  return readByIds(db, 'sessions', SessionSchema, ids, ['id'], 'id')
}

const SessionCostSchema = z.object({
  started_at: z.number(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
})

/**
 * Spend of the sessions started in [fromSec, toSec]: the billed cost when known, else Hermes' estimate.
 * Null (unknown, never zero) when a session has no cost, or when a session that started earlier was still active
 * in the window: Hermes keeps one cumulative cost per session, so its share inside the window is not recoverable.
 */
export function sessionSpend(db: DatabaseSync, fromSec: number, toSec: number): number | null {
  const batch = readBatch(
    db,
    'sessions',
    SessionCostSchema.extend({
      last_activity_at: z.number().nullable(),
      ended_at: z.number().nullable(),
    }),
    'WHERE started_at <= ? AND COALESCE(last_activity_at, ended_at, started_at) >= ?',
    [toSec, fromSec],
  )
  if (batch.malformed) return null
  let total = 0
  for (const row of batch.rows) {
    const cost = row.actual_cost_usd ?? row.estimated_cost_usd
    if (cost === null || row.started_at < fromSec) return null
    total += cost
  }
  return total
}

/**
 * Sessions active at or after sinceSec with their cumulative cost, for Score's snapshots. Null when a row is
 * malformed (the caller then keeps the unknown). Billed cost wins over Hermes' estimate.
 */
export function readSessionCosts(db: DatabaseSync, sinceSec: number): SessionCost[] | null {
  const batch = readBatch(
    db,
    'sessions',
    SessionCostSchema.extend({
      id: z.string(),
      last_activity_at: z.number().nullable(),
      ended_at: z.number().nullable(),
    }),
    'WHERE COALESCE(last_activity_at, ended_at, started_at) >= ?',
    [sinceSec],
  )
  if (batch.malformed) return null
  return batch.rows.map((row) => ({
    sessionId: row.id,
    startedAt: row.started_at * 1000,
    costUsd: row.actual_cost_usd ?? row.estimated_cost_usd,
    estimated: row.actual_cost_usd === null,
  }))
}

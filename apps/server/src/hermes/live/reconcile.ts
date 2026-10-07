import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { parseJson, readBatch, type JsonValue, type ReaderBatch } from './sqlite.ts'

const TextSchema = z.string().nullable()
const FlagSchema = z.union([z.literal(0), z.literal(1)])
const RecentInputSchema = z.object({
  sinceEpochSeconds: z.number(),
  maxSessions: z.int().nonnegative().optional(),
})
const SessionInputSchema = z.object({ sessionId: z.string().min(1) })
const RecentReconcileInputSchema = RecentInputSchema.extend({
  maxSessions: z.int().nonnegative().default(50),
})
const RecentSessionRowSchema = z.object({
  id: z.string().min(1),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  last_activity_at: z.number().nullable(),
})
const ColumnSchema = z.object({ name: z.string() })
const OptionalMessageFieldsSchema = z.object({
  message_uid: z.string().min(1).nullable().optional(),
  tool_call_uid: TextSchema.optional(),
  tool_call_uids: TextSchema.optional(),
  reasoning: TextSchema.optional(),
})
const ToolCallSchema = z.object({ id: z.string().min(1) })
const ToolCallUidsSchema = z.record(
  z.string().min(1),
  z.union([z.string().min(1), z.array(z.string().min(1))]),
)

export interface MessageRevision {
  sessionId: string
  logicalId: string
  physicalId: number
  physicalIds: number[]
  role: string
  active: boolean
  compacted: boolean
  contentHash: string
  toolCallIds: string[]
  revision: string
}

export interface RosterRevision {
  sessionId: string
  liveLogicalIds: string[]
  revision: string
}

export interface SessionReconciliation {
  messages: MessageRevision[]
  roster: RosterRevision
  malformed: number
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function readToolCallIds(
  toolCalls: JsonValue,
  toolCallId: string | null,
  toolCallUid: string | null | undefined,
  toolCallUids: string | null | undefined,
) {
  const parsedUids = parseJson(toolCallUids ?? null)
  const uidMap = ToolCallUidsSchema.safeParse(parsedUids.value ?? {})
  let malformed = parsedUids.malformed > 0 || !uidMap.success
  const ids = new Set<string>()
  if (toolCallUid) ids.add(toolCallUid)
  else if (toolCallId) ids.add(toolCallId)
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const parsed = ToolCallSchema.safeParse(call)
      if (!parsed.success) {
        malformed = true
        continue
      }
      const uids = uidMap.success ? uidMap.data[parsed.data.id] : undefined
      if (Array.isArray(uids) && uids.length > 0) {
        for (const uid of uids) ids.add(uid)
      } else if (typeof uids === 'string') ids.add(uids)
      else ids.add(parsed.data.id)
    }
  }
  return { ids: [...ids].sort(), malformed }
}

/** Use either activity marker; start time is a fallback only when both markers are absent. */
export function recentSessions(
  db: DatabaseSync,
  input: z.input<typeof RecentInputSchema>,
): ReaderBatch<string> {
  const { sinceEpochSeconds, maxSessions } = RecentInputSchema.parse(input)
  const batch = readBatch(
    db,
    'sessions',
    RecentSessionRowSchema,
    `WHERE last_activity_at >= ? OR ended_at >= ?
      OR (last_activity_at IS NULL AND ended_at IS NULL AND started_at >= ?)
     ORDER BY CASE WHEN last_activity_at IS NULL AND ended_at IS NULL THEN started_at
       ELSE MAX(COALESCE(last_activity_at, ended_at), COALESCE(ended_at, last_activity_at))
       END DESC, id${maxSessions === undefined ? '' : ' LIMIT ?'}`,
    [
      sinceEpochSeconds,
      sinceEpochSeconds,
      sinceEpochSeconds,
      ...(maxSessions === undefined ? [] : [maxSessions]),
    ],
  )
  return { rows: batch.rows.map((row) => row.id), malformed: batch.malformed }
}

export function reconcileSession(
  db: DatabaseSync,
  input: z.input<typeof SessionInputSchema>,
): SessionReconciliation {
  const { sessionId } = SessionInputSchema.parse(input)
  const columns = new Set<string>()
  let malformed = 0
  for (const row of db.prepare('PRAGMA table_info(messages)').all()) {
    const parsed = ColumnSchema.safeParse(row)
    if (parsed.success) columns.add(parsed.data.name)
    else malformed++
  }
  // Optional columns differ between older databases and current Hermes installations.
  const schema = z.object({
    id: z.int().positive(),
    session_id: z.string().min(1),
    role: z.string().min(1),
    content: TextSchema,
    tool_calls: TextSchema,
    tool_name: TextSchema,
    tool_call_id: TextSchema,
    timestamp: z.number(),
    active: FlagSchema,
    compacted: FlagSchema,
    ...(columns.has('message_uid') ? { message_uid: z.string().min(1).nullable() } : {}),
    ...(columns.has('tool_call_uid') ? { tool_call_uid: TextSchema } : {}),
    ...(columns.has('tool_call_uids') ? { tool_call_uids: TextSchema } : {}),
    ...(columns.has('reasoning') ? { reasoning: TextSchema } : {}),
  })
  const batch = readBatch(db, 'messages', schema, 'WHERE session_id = ? ORDER BY id', [sessionId])
  malformed += batch.malformed
  const logical = new Map<string, MessageRevision>()
  for (const row of batch.rows) {
    const optional = OptionalMessageFieldsSchema.safeParse(row)
    if (!optional.success) {
      malformed++
      continue
    }
    const logicalId = optional.data.message_uid ?? `id:${row.id}`
    const toolCalls = parseJson(row.tool_calls)
    const toolCallIds = readToolCallIds(
      toolCalls.value,
      row.tool_call_id,
      optional.data.tool_call_uid,
      optional.data.tool_call_uids,
    )
    if (toolCalls.malformed > 0 || toolCallIds.malformed) malformed++
    const contentHash = hash({
      content: row.content,
      tool_calls: toolCalls.value,
      tool_name: row.tool_name,
      tool_call_id: row.tool_call_id,
      ...(optional.data.reasoning == null ? {} : { reasoning: optional.data.reasoning }),
    })
    const physicalIds = logical.get(logicalId)?.physicalIds ?? []
    physicalIds.push(row.id)
    const previous = logical.get(logicalId)
    // Rows arrive in ID order; an inactive copy must never replace an active one.
    if (previous?.active && row.active === 0) continue
    logical.set(logicalId, {
      sessionId,
      logicalId,
      physicalId: row.id,
      physicalIds,
      role: row.role,
      active: row.active === 1,
      compacted: row.compacted === 1,
      contentHash,
      toolCallIds: toolCallIds.ids,
      revision: `${row.active}${row.compacted}:${contentHash.slice(0, 16)}`,
    })
  }
  const messages = [...logical.values()]
  const liveLogicalIds = messages
    .filter((message) => message.active)
    .map((message) => message.logicalId)
    .sort()
  return {
    messages,
    roster: { sessionId, liveLogicalIds, revision: hash(liveLogicalIds) },
    malformed,
  }
}

export function revisionIdentity(
  profile: string,
  incarnation: string,
  revision: MessageRevision | RosterRevision,
): string {
  z.string().min(1).parse(profile)
  z.string().min(1).parse(incarnation)
  return 'logicalId' in revision
    ? `message:${profile}:${incarnation}:${revision.logicalId}@${revision.revision}`
    : `roster:${profile}:${incarnation}:${revision.sessionId}@${revision.revision}`
}

export function reconcileRecent(
  db: DatabaseSync,
  input: z.input<typeof RecentReconcileInputSchema>,
) {
  const options = RecentReconcileInputSchema.parse(input)
  const recent = recentSessions(db, options)
  const sessions = recent.rows.map((sessionId) => reconcileSession(db, { sessionId }))
  return {
    sessions,
    malformed: recent.malformed + sessions.reduce((sum, session) => sum + session.malformed, 0),
  }
}

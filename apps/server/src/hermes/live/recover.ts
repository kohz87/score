import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly, readBatch } from './sqlite.ts'

const RowSchema = z.object({
  id: z.int().positive(),
  role: z.string(),
  content: z.string().nullable(),
  tool_calls: z.string().nullable(),
  timestamp: z.number(),
})

export interface RecoverRequest {
  profile: string
  sessionId: string
  /** Run start, epoch seconds: only what Hermes wrote after it can belong to this run. */
  startedAt: number
}

/**
 * The session plus its compression continuations: compression ends a session (end_reason 'compression') and the
 * run keeps writing to a child. Branches, delegates and tool sessions are not continuations; an ambiguous fork
 * stops the walk.
 */
function compressionLineage(db: DatabaseSync, sessionId: string): string[] {
  const lineage = [sessionId]
  try {
    const children = db.prepare(
      `SELECT c.id FROM sessions c JOIN sessions p ON p.id = c.parent_session_id
       WHERE p.id = ? AND p.end_reason = 'compression' AND COALESCE(c.source, '') != 'tool'`,
    )
    for (let hop = 0; hop < 20; hop++) {
      const found = children.all(lineage.at(-1)!) as { id: string }[]
      if (found.length !== 1 || lineage.includes(found[0]!.id)) break
      lineage.push(found[0]!.id)
    }
  } catch {
    // An older schema without the lineage columns has no continuations to follow.
  }
  return lineage
}

/**
 * The final answer of a turn Hermes no longer has a run record for, read (read-only) from the profile's own
 * session history: the messages after the turn's user message must end in a plain assistant reply. A turn that
 * is still working (ends in a tool step) or left nothing gives null, so the caller marks the run interrupted.
 */
export function recoverRunOutput(request: RecoverRequest, hermesHome?: string): string | null {
  if (!ProfileNameSchema.safeParse(request.profile).success) return null
  const path = hermesPaths(resolveHermesHome(hermesHome)).stateDb(request.profile)
  try {
    const db = openReadOnly(path)
    try {
      const sessions = compressionLineage(db, request.sessionId)
      const { rows: all } = readBatch(
        db,
        'messages',
        RowSchema,
        `WHERE session_id IN (${sessions.map(() => '?').join(',')}) AND active = 1 AND timestamp >= ? ORDER BY id`,
        [...sessions, request.startedAt],
      )
      const start = all.findIndex((row) => row.role === 'user')
      if (start === -1) return null
      // Only this turn: a later user message is another turn (the owner may have resumed the session in Hermes).
      const next = all.findIndex((row, index) => index > start && row.role === 'user')
      const rows = all.slice(start, next === -1 ? undefined : next)
      const last = rows.at(-1)!
      if (last.role !== 'assistant' || !last.content?.trim()) return null
      if (last.tool_calls && last.tool_calls !== '[]' && last.tool_calls !== 'null') return null
      return last.content
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof HermesDbMissing || error instanceof HermesSchemaDrift) return null
    throw error
  }
}

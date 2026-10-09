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
  /** The exact input Score sent: the turn's user message must be it, or nothing is recovered. */
  input: string | null
}

// Hermes stores a string input verbatim as the user message. An input with images is stored as its text part (which can
// end in Score's note about images it could not send) plus one "[screenshot]" line per image (session_persistence.py).
// Hermes stores the user message as the turn starts; admission to that write takes seconds, not minutes.
const TURN_START_SECONDS = 120
const UNSENT_NOTE = /^\n\n\(\d+ attached images? could not be sent[^\n]*\)$/
function isTurnInput(content: string | null, input: string): boolean {
  if (content === null) return false
  const text = content.replace(/(?:\n\[screenshot\])+$/, '')
  if (text.trim() === input.trim()) return true
  return text.startsWith(input) && UNSENT_NOTE.test(text.slice(input.length))
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
  if (!ProfileNameSchema.safeParse(request.profile).success || !request.input) return null
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
      // Hermes can admit a run and stop before it stores the user message; the first later user message is then
      // another turn (the owner resumed the session) and its answer must not complete this run or route hand-offs.
      // Hermes rows carry no run identity, so the turn is proven by its exact input *and* by Hermes having stored it
      // when the run started: a turn typed by hand later, even with the same words ("go"), is not this run.
      const first = all[start]
      if (
        !first ||
        !isTurnInput(first.content, request.input) ||
        first.timestamp - request.startedAt > TURN_START_SECONDS
      )
        return null
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

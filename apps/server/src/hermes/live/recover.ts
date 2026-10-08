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
      const { rows } = readBatch(
        db,
        'messages',
        RowSchema,
        'WHERE session_id = ? AND active = 1 AND timestamp >= ? ORDER BY id',
        [request.sessionId, request.startedAt],
      )
      const start = rows.findIndex((row) => row.role === 'user')
      if (start === -1) return null
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

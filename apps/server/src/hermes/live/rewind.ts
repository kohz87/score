import { REWIND_COMMAND_TTL_MS } from '@score/contract'
import { z } from 'zod'
import type { RewindBroker } from '../bridge/rewind-broker.ts'
import type { RewindSessionResult } from '../port.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { compressionLineage } from './recover.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly } from './sqlite.ts'

const BRIDGE_ANSWER_MS = REWIND_COMMAND_TTL_MS

type Inspection =
  | { ok: true; sessionId: string; turns: number; undone: number }
  | { ok: false; reason: 'no_session' | 'compressed' }

/**
 * Read-only look at the agent's room session in its Hermes history: the session that holds the turns from `since` on
 * (the tip of its compression lineage) and how many user turns it has there. A compression after `since` splits those
 * turns over two sessions, which Score does not rewind across.
 */
export function inspectSession(
  req: { profile: string; sessionId: string; sinceSeconds: number },
  hermesHome?: string,
): Inspection {
  if (!ProfileNameSchema.safeParse(req.profile).success) return { ok: false, reason: 'no_session' }
  try {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).stateDb(req.profile))
    try {
      const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(req.sessionId)
      if (!exists) return { ok: false, reason: 'no_session' }
      const lineage = compressionLineage(db, req.sessionId)
      const started = z
        .object({ started_at: z.number().nullable() })
        .array()
        .parse(
          lineage
            .slice(1)
            .map((id) => db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(id)),
        )
      // A continuation that began after `since` means the compression happened after the message.
      if (started.some((row) => row.started_at === null || row.started_at >= req.sinceSeconds))
        return { ok: false, reason: 'compressed' }
      const tip = lineage.at(-1)!
      const count = (extra: string, active = 1) =>
        z.object({ count: z.int() }).parse(
          db
            .prepare(
              `SELECT count(*) AS count FROM messages WHERE session_id = ? AND role = 'user' AND active = ?
                 AND timestamp >= ?${extra}`,
            )
            .get(tip, active, req.sinceSeconds),
        ).count
      let turns: number
      let undone: number
      // Rows Hermes writes for display only are not turns the person started, and rows an in-place compaction
      // archived (`active = 0, compacted = 1`) were not undone: only an undo or rewind qualifies as "undone".
      // Older schemas lack a column, so fall back to the narrower query.
      try {
        turns = count(' AND display_kind IS NULL')
        undone = count(' AND display_kind IS NULL AND compacted = 0', 0)
      } catch {
        try {
          turns = count(' AND display_kind IS NULL')
          undone = count(' AND display_kind IS NULL', 0)
        } catch {
          turns = count('')
          undone = count('', 0)
        }
      }
      return { ok: true, sessionId: tip, turns, undone }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)
      return { ok: false, reason: 'no_session' }
    throw error
  }
}

export async function rewindSession(
  req: {
    agentId: string
    sessionId: string
    turns: number
    sinceMs: number
    dryRun?: boolean
  },
  deps: { broker: RewindBroker | undefined; hermesHome?: string },
): Promise<RewindSessionResult> {
  const found = inspectSession(
    { profile: req.agentId, sessionId: req.sessionId, sinceSeconds: req.sinceMs / 1000 },
    deps.hermesHome,
  )
  if (!found.ok) return { status: 'skipped', reason: found.reason }
  // Hermes already undid these turns (an earlier rewind that Score never got the answer to, or an /undo): nothing
  // active is left since the message, so the session is where the person wants it.
  if (found.turns === 0 && found.undone > 0)
    return req.dryRun ? { status: 'ready' } : { status: 'rewound', turnsUndone: 0, rewoundCount: 0 }
  if (found.turns !== req.turns) return { status: 'skipped', reason: 'turn_count_mismatch' }
  if (!deps.broker?.available(req.agentId))
    return { status: 'skipped', reason: 'bridge_unavailable' }
  if (req.dryRun) return { status: 'ready' }
  const outcome = await deps.broker.request(
    req.agentId,
    { sessionId: found.sessionId, turns: req.turns, since: req.sinceMs / 1000 },
    BRIDGE_ANSWER_MS,
  )
  switch (outcome.status) {
    case 'done':
      return {
        status: 'rewound',
        turnsUndone: outcome.turnsUndone,
        rewoundCount: outcome.rewoundCount,
      }
    case 'unavailable':
      return { status: 'skipped', reason: 'bridge_unavailable' }
    case 'expired':
    case 'no_answer':
      return { status: 'skipped', reason: 'no_answer' }
    default:
      return { status: 'skipped', reason: 'rewind_failed' }
  }
}

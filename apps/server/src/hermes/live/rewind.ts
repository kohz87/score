import { z } from 'zod'
import type { RewindBroker } from '../bridge/rewind-broker.ts'
import type { RewindSessionResult } from '../port.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { compressionLineage } from './recover.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly } from './sqlite.ts'

const BRIDGE_ANSWER_MS = 60_000

type Inspection = { ok: true; sessionId: string; turns: number } | { ok: false; reason: 'no_session' | 'compressed' }

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
      const count = (extra: string) =>
        z
          .object({ count: z.int() })
          .parse(
            db
              .prepare(
                `SELECT count(*) AS count FROM messages WHERE session_id = ? AND role = 'user' AND active = 1
                 AND timestamp >= ?${extra}`,
              )
              .get(tip, req.sinceSeconds),
          ).count
      let turns: number
      try {
        // Rows Hermes writes for display only are not turns the person started.
        turns = count(' AND display_kind IS NULL')
      } catch {
        turns = count('')
      }
      return { ok: true, sessionId: tip, turns }
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
  if (found.turns !== req.turns) return { status: 'skipped', reason: 'turn_count_mismatch' }
  if (!deps.broker?.available(req.agentId)) return { status: 'skipped', reason: 'bridge_unavailable' }
  if (req.dryRun) return { status: 'ready' }
  const outcome = await deps.broker.request(
    req.agentId,
    { sessionId: found.sessionId, turns: req.turns },
    BRIDGE_ANSWER_MS,
  )
  switch (outcome.status) {
    case 'done':
      return { status: 'rewound', turnsUndone: outcome.turnsUndone, rewoundCount: outcome.rewoundCount }
    case 'unavailable':
      return { status: 'skipped', reason: 'bridge_unavailable' }
    case 'no_answer':
      return { status: 'skipped', reason: 'no_answer' }
    default:
      return { status: 'skipped', reason: 'rewind_failed' }
  }
}

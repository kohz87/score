import { COMPACT_COMMAND_TTL_MS, type SessionContextReading } from '@score/contract'
import type { RewindBroker } from '../bridge/rewind-broker.ts'
import type { CompactSessionResult } from '../port.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { compressionLineage } from './recover.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly } from './sqlite.ts'

/** The context query is read-only and has no model call: a short window. */
const CONTEXT_ANSWER_MS = 20_000

/**
 * The session that currently holds the conversation: the tip of the room session's compression lineage, read-only
 * (a compacted session continues in a child). Null when Hermes has no such session.
 */
export function sessionTip(
  req: { profile: string; sessionId: string },
  hermesHome?: string,
): string | null {
  if (!ProfileNameSchema.safeParse(req.profile).success) return null
  try {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).stateDb(req.profile))
    try {
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(req.sessionId)) return null
      return compressionLineage(db, req.sessionId).at(-1) ?? null
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof HermesDbMissing || error instanceof HermesSchemaDrift) return null
    throw error
  }
}

export async function compactSession(
  req: { agentId: string; sessionId: string; keepRecent?: number },
  deps: { broker: RewindBroker | undefined; hermesHome?: string },
): Promise<CompactSessionResult> {
  const tip = sessionTip({ profile: req.agentId, sessionId: req.sessionId }, deps.hermesHome)
  if (tip === null) return { status: 'failed', reason: 'no_session' }
  if (!deps.broker?.available(req.agentId))
    return { status: 'failed', reason: 'bridge_unavailable' }
  const outcome = await deps.broker.ask(
    req.agentId,
    {
      kind: 'compact',
      sessionId: tip,
      ...(req.keepRecent === undefined ? {} : { keepRecent: req.keepRecent }),
    },
    COMPACT_COMMAND_TTL_MS,
  )
  switch (outcome.status) {
    case 'done':
      return outcome.before && outcome.after
        ? { status: 'compacted', before: outcome.before, after: outcome.after }
        : { status: 'failed', reason: 'compact_failed' }
    case 'nothing':
      return { status: 'nothing' }
    case 'unavailable':
      return { status: 'failed', reason: 'bridge_unavailable' }
    case 'expired':
    case 'no_answer':
      return { status: 'failed', reason: 'no_answer' }
    default:
      return {
        status: 'failed',
        reason:
          outcome.error === 'lock_held' || outcome.error === 'session_busy'
            ? 'session_busy'
            : 'compact_failed',
      }
  }
}

export async function sessionContext(
  req: { agentId: string; sessionId: string },
  deps: { broker: RewindBroker | undefined; hermesHome?: string },
): Promise<SessionContextReading | null> {
  if (!deps.broker?.available(req.agentId)) return null
  const tip = sessionTip({ profile: req.agentId, sessionId: req.sessionId }, deps.hermesHome)
  if (tip === null) return null
  const outcome = await deps.broker.ask(
    req.agentId,
    { kind: 'context_breakdown', sessionId: tip },
    CONTEXT_ANSWER_MS,
  )
  return outcome.status === 'done' ? (outcome.context ?? null) : null
}

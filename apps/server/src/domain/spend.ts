import type { DatabaseSync } from 'node:sqlite'

/** One Hermes session as Hermes reports it: cost is cumulative, null when Hermes has none. */
export interface SessionCost {
  sessionId: string
  /** Epoch ms. */
  startedAt: number
  costUsd: number | null
  estimated: boolean
}

const HOUR = 3_600_000
// Readings are bucketed per quarter hour, not per hour: every real UTC offset is a multiple of 15 minutes, so a
// bucket never spans a local midnight and a later reading cannot overwrite the baseline taken before it.
const BUCKET = 900_000
export const SNAPSHOT_RETENTION_MS = 60 * 24 * HOUR

/** Upserts one snapshot per session per quarter hour (the later reading wins), then prunes rows past retention. */
export function recordSessionCosts(
  sqlite: DatabaseSync,
  profile: string,
  sessions: SessionCost[],
  now: number,
): void {
  const upsert = sqlite.prepare(
    `INSERT INTO session_cost_snapshots (profile, session_id, hour, observed_at, cost_usd, estimated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (profile, session_id, hour)
     DO UPDATE SET observed_at = excluded.observed_at, cost_usd = excluded.cost_usd, estimated = excluded.estimated`,
  )
  for (const session of sessions) {
    if (session.costUsd === null) continue
    upsert.run(
      profile,
      session.sessionId,
      Math.floor(now / BUCKET), // the `hour` column holds the bucket number
      now,
      session.costUsd,
      session.estimated ? 1 : 0,
    )
  }
  sqlite
    .prepare('DELETE FROM session_cost_snapshots WHERE observed_at < ?')
    .run(now - SNAPSHOT_RETENTION_MS)
}

/**
 * Spend of one session in [from, to]: the cost at its last snapshot inside the window minus the cost at the last
 * snapshot before it. A session that started inside the window has an implicit zero baseline; one that started
 * earlier with no snapshot before the window is unknown (null), never zero.
 */
export function sessionSpendInWindow(
  sqlite: DatabaseSync,
  profile: string,
  session: SessionCost,
  from: number,
  to: number,
): number | null {
  const last = (op: string, bound: number[]) =>
    sqlite
      .prepare(
        `SELECT cost_usd FROM session_cost_snapshots
         WHERE profile = ? AND session_id = ? AND ${op} ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(profile, session.sessionId, ...bound) as { cost_usd: number } | undefined
  const before = last('observed_at < ?', [from])
  const inside = last('observed_at >= ? AND observed_at <= ?', [from, to])
  const baseline = before?.cost_usd ?? (session.startedAt >= from ? 0 : null)
  if (baseline === null) return null
  const end = inside?.cost_usd ?? before?.cost_usd ?? null
  if (end === null) return null
  return Math.max(0, end - baseline)
}

/** Null (unknown) when any session has no cost or no baseline; the sum otherwise. Zero sessions is zero spend. */
export function profileSpendInWindow(
  sqlite: DatabaseSync,
  profile: string,
  sessions: SessionCost[],
  from: number,
  to: number,
): number | null {
  let total = 0
  for (const session of sessions) {
    if (session.costUsd === null) return null
    const spend = sessionSpendInWindow(sqlite, profile, session, from, to)
    if (spend === null) return null
    total += spend
  }
  return total
}

/** The periodic sample: sessions active in the last two hours, for every agent the port can read. */
export async function snapshotSessionCosts(
  db: { tx<T>(fn: (sqlite: DatabaseSync) => T): T },
  source: {
    listAgents(): Promise<{ id: string }[]>
    sessionCosts?(req: {
      sinceMs: number
      agentIds: string[]
    }): Promise<Record<string, SessionCost[]>>
  },
  now: number,
): Promise<void> {
  if (!source.sessionCosts) return
  const agentIds = (await source.listAgents()).map((agent) => agent.id)
  const costs = await source.sessionCosts({ sinceMs: now - 2 * HOUR, agentIds })
  db.tx((sqlite) => {
    for (const [profile, sessions] of Object.entries(costs))
      recordSessionCosts(sqlite, profile, sessions, now)
  })
}

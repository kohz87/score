import type { DatabaseSync } from 'node:sqlite'

interface ActiveCounts {
  perAgent: Map<string, number>
  perRun: Map<string, number>
  total: number
}

/** Step attempts that hold capacity: not yet terminal, not abandoned (abandonment releases capacity). */
export function activeStepCounts(sqlite: DatabaseSync): ActiveCounts {
  const rows = sqlite
    .prepare(
      `SELECT a.orchestration_id AS orch, a.agent_id AS agent, COUNT(*) AS n,
              COALESCE(s.role IN ('helper', 'vote'), 0) AS helper
         FROM orc_attempts a LEFT JOIN orc_steps s ON s.orchestration_id = a.orchestration_id AND s.id = a.step_id
       WHERE a.kind = 'step' AND a.state IN ('created', 'send_started', 'running', 'unknown') AND a.abandoned_at IS NULL
         AND a.suspended = 0
       GROUP BY a.orchestration_id, a.agent_id, helper`,
    )
    .all() as { orch: string; agent: string; n: number; helper: number }[]
  const counts: ActiveCounts = { perAgent: new Map(), perRun: new Map(), total: 0 }
  for (const row of rows) {
    counts.perAgent.set(row.agent, (counts.perAgent.get(row.agent) ?? 0) + row.n)
    // 3.15: helper work counts in the run's helper slots (`<run>#helpers`), not the lead's.
    const slot = row.helper ? `${row.orch}#helpers` : row.orch
    counts.perRun.set(slot, (counts.perRun.get(slot) ?? 0) + row.n)
    counts.total += row.n
  }
  return counts
}

/**
 * v8.1 item 2: every change that can make waiting work admissible (limits raised, Resume, fence lift, waiver, capacity
 * or quota released, an agent ready again) increments the global admission revision in its own transaction. Runs
 * remember the revision they last evaluated, so a restart between the change and the pass loses nothing.
 */
export function bumpAdmission(sqlite: DatabaseSync): void {
  sqlite
    .prepare('UPDATE orc_global SET admission_revision = admission_revision + 1 WHERE id = 1')
    .run()
}
export const admissionRevision = (sqlite: DatabaseSync): number =>
  (
    sqlite.prepare('SELECT admission_revision AS r FROM orc_global WHERE id = 1').get() as {
      r: number
    }
  ).r

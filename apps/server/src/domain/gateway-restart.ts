import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

// 3.7.9 (decision 140): Score restarts an agent's gateway only when it sees nothing of that agent's in flight. `default`
// restarts the shared gateway every profile runs in, so there nothing of any agent may be in flight.

const Count = z.object({ n: z.int().nonnegative() })

/** Why the gateway can't be restarted now, or null. `profile` null = any profile (the shared gateway). */
export function gatewayRestartBlocker(sqlite: DatabaseSync, profile: string | null): string | null {
  const scoped = (column: string) => (profile === null ? '1 = 1' : `${column} = ?1`)
  const count = (sql: string) =>
    Count.parse(sqlite.prepare(sql).get(...(profile === null ? [] : [profile]))).n
  const runs = count(
    `SELECT (SELECT count(*) FROM runs WHERE ${scoped('profile')} AND status IN ('queued','running','waiting_for_approval'))
          + (SELECT count(*) FROM command_intents WHERE kind = 'start_run' AND ${scoped("json_extract(payload, '$.profile')")} AND state IN ('pending','sent','unknown'))
          + (SELECT count(*) FROM message_runs WHERE ${scoped('agent_id')} AND state IN ('pending','active')) AS n`,
  )
  const approvals = count(
    `SELECT count(*) AS n FROM approvals WHERE ${scoped('profile')} AND status = 'pending'`,
  )
  const who = profile === null ? 'An agent' : 'It'
  if (runs)
    return `${who} is working or has a turn queued. Wait for it to finish, or stop it, then reload.`
  if (approvals)
    return `${who} is waiting for an approval. Answer it first: a restart would lose the paused step.`
  return null
}

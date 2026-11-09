import type { DatabaseSync } from 'node:sqlite'
import { defaultJobId } from '../job-sessions.ts'
import { subagentTotalReached } from '../subagents.ts'

// A run's subagent limits live on the job the person sees: the one it was started as, in the team room (Start a job,
// `recipe`), else its own room's one job.

function jobOfRun(sqlite: DatabaseSync, orchestrationId: string): string | null {
  const started = sqlite
    .prepare(
      `SELECT id FROM jobs WHERE recipe_ref = ? AND recipe_kind IN ('orchestration', 'workflow')
       AND deleted_at IS NULL LIMIT 1`,
    )
    .get(orchestrationId) as { id: string } | undefined
  if (started) return started.id
  const row = sqlite
    .prepare('SELECT room_id FROM orchestrations WHERE id = ?')
    .get(orchestrationId) as { room_id: string } | undefined
  return row ? defaultJobId(sqlite, row.room_id) : null
}

export function runJobScope(sqlite: DatabaseSync, orchestrationId: string): { jobId?: string } {
  const jobId = jobOfRun(sqlite, orchestrationId)
  return jobId ? { jobId } : {}
}

export function runSubagentTotalReached(sqlite: DatabaseSync, orchestrationId: string): boolean {
  const jobId = jobOfRun(sqlite, orchestrationId)
  return jobId !== null && subagentTotalReached(sqlite, jobId)
}

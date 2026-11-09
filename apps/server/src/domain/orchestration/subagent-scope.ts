import type { DatabaseSync } from 'node:sqlite'
import { defaultJobId } from '../job-sessions.ts'
import { subagentTotalReached } from '../subagents.ts'

// A run's subagent limits live on its room's one job (decision 173): a room on @mentions has only its default job.

function jobOfRun(sqlite: DatabaseSync, orchestrationId: string): string | null {
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

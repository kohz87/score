import type { DatabaseSync } from 'node:sqlite'

/** `working` while any other agent turn of the job is queued or running; otherwise the job waits on the person. */
export function jobState(
  sqlite: DatabaseSync,
  jobId: string,
  settling: string,
): 'working' | 'waiting_on_you' {
  const open = sqlite
    .prepare(
      `SELECT 1 FROM message_runs WHERE job_id = ? AND turn_id != ? AND purpose IS NULL
         AND state IN ('pending', 'active') LIMIT 1`,
    )
    .get(jobId, settling)
  return open ? 'working' : 'waiting_on_you'
}

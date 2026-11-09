import type { Job, SubagentsChanged } from '@score/contract'

/** `subagents.changed`: replace the job's limits/count in every list that carries it, wherever that list lives. */
export function withChangedSubagents(jobs: readonly Job[], changed: SubagentsChanged): Job[] {
  return jobs.map((job) =>
    job.id === changed.jobId ? { ...job, subagents: changed.subagents } : job,
  )
}

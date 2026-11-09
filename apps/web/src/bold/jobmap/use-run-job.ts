import type { Job } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomJobsQuery } from '../room/room-queries.ts'

/**
 * The job a lead-decides run belongs to (SA.3 part 8), as the server names it: a run started from a chat sits in that
 * chat's job, not in the run's own room. Undefined while the room's jobs load, or for a run with no job.
 */
export function useRunJob(ref: { id: string; roomId: string } | null | undefined): Job | undefined {
  const jobs = useStreamQuery(roomJobsQuery(ref?.roomId ?? null)).data
  return jobs?.find((job) => job.id === ref?.id)
}

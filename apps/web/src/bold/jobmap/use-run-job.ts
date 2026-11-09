import type { Job } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { roomJobsQuery } from '../room/room-queries.ts'

/**
 * The job a lead-decides run belongs to (SA.3 part 8): the room's job whose recipe names the run. The map's page is
 * opened from a chat's Graph tab and from a chat-less run's sheet, so it reads the room's list rather than being handed
 * the job. Undefined while the room's jobs load, or when the run has no job (an old run from before topics).
 */
export function useRunJob(roomId: string | null, orchestrationId: string): Job | undefined {
  const jobs = useStreamQuery(roomJobsQuery(roomId)).data
  return jobs?.find(
    (job) => job.recipe?.kind === 'orchestration' && job.recipe.ref === orchestrationId,
  )
}

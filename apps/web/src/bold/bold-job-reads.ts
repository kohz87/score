import { JobsResponseSchema, TeamRoomResponseSchema, type Job, type Room } from '@score/contract'
import { apiFetch } from '../data/api.ts'

/** The complete room job list: open jobs and the closed ones the job menu can reopen. */
export async function fetchCompleteJobs(
  roomId: string,
  signal?: AbortSignal,
): Promise<{ asOfSeq: number; items: Job[] }> {
  const response = JobsResponseSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(roomId)}/jobs?closed=include`, { signal }),
  )
  return { asOfSeq: response.asOfSeq, items: response.items }
}

/** The team room plus its complete job list. `GET /api/team-room` itself leaves closed jobs out. */
export async function fetchCompleteTeamRoom(
  signal?: AbortSignal,
): Promise<{ asOfSeq: number; room: Room; jobs: Job[] }> {
  const snapshot = TeamRoomResponseSchema.parse(await apiFetch('team-room', { signal }))
  const jobs = await fetchCompleteJobs(snapshot.room.id, signal)
  return {
    asOfSeq: Math.max(snapshot.asOfSeq, jobs.asOfSeq),
    room: snapshot.room,
    jobs: jobs.items,
  }
}

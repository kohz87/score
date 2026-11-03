import { JobSchema, type Job, type Room } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { questionsQuery } from '../../data/question-queries.ts'
import { agentsQuery, approvalsQuery, roomsQuery } from '../../routes/chat/queries.ts'
import { fetchCompleteJobs } from '../bold-job-reads.ts'
import { teamRoomQuery, teamRoomsQuery, withJob, withoutJob } from '../room/room-queries.ts'
import { buildChatLists, type ChatLists } from './chat-model.ts'

/** The jobs of several rooms in one registration, so the list can order and describe every chat it shows. */
export function chatJobsQuery(roomIds: string[]) {
  const ids = [...new Set(roomIds)].sort()
  return defineStreamQuery<Record<string, Job[]>>({
    key: ['bold', 'chat-list-jobs', ...ids],
    async fetch(signal) {
      const reads = await Promise.all(ids.map((id) => fetchCompleteJobs(id, signal)))
      return {
        asOfSeq: reads.reduce((highest, read) => Math.max(highest, read.asOfSeq), 0),
        data: Object.fromEntries(ids.map((id, index) => [id, reads[index]!.items])),
      }
    },
    types: ['job.upserted', 'job.deleted'],
    reduce(data, event) {
      if (event.type === 'job.deleted') {
        const jobs = data[event.data.roomId]
        return jobs ? { ...data, [event.data.roomId]: withoutJob(jobs, event.data.id) } : data
      }
      if (event.type !== 'job.upserted' || !(event.data.roomId in data)) return data
      return {
        ...data,
        [event.data.roomId]: withJob(data[event.data.roomId]!, JobSchema.parse(event.data)),
      }
    },
  })
}

/** The chat list's two groups, from reads the shell already makes (rooms, team rooms, agents, approvals, questions). */
export function useChatLists(): ChatLists & { ready: boolean } {
  const rooms = useStreamQuery(roomsQuery).data
  const teamRooms = useStreamQuery(teamRoomsQuery).data
  const agents = useStreamQuery(agentsQuery).data
  const approvals = useStreamQuery(approvalsQuery).data
  const questions = useStreamQuery(questionsQuery).data
  const roomIds = [...(teamRooms ?? []), ...(rooms?.rooms ?? []), ...(rooms?.directs ?? [])].map(
    (room) => room.id,
  )
  const key = roomIds.join('\u0000')
  const definition = useMemo(() => chatJobsQuery(key ? key.split('\u0000') : []), [key])
  const jobs = useStreamQuery(definition).data
  return useMemo(
    () => ({
      ...buildChatLists({
        rooms: rooms?.rooms ?? [],
        teamRooms: teamRooms ?? [],
        directRooms: rooms?.directs ?? [],
        agents: agents ?? [],
        jobsByRoom: jobs ?? {},
        approvals: approvals ?? [],
        questions: questions ?? [],
      }),
      ready: rooms !== undefined && teamRooms !== undefined && agents !== undefined,
    }),
    [rooms, teamRooms, agents, jobs, approvals, questions],
  )
}

/** The group chat the address names: `?room=` or, without it, the team room (the same rule the room column uses). */
export function useOpenGroup(override: string | null): Room | null {
  const definition = useMemo(() => teamRoomQuery(override), [override])
  const read = useStreamQuery(definition).data
  const teamDefinition = useMemo(() => teamRoomQuery(null), [])
  const team = useStreamQuery(teamDefinition).data
  const rooms = useStreamQuery(roomsQuery).data?.rooms ?? []
  const teamRooms = useStreamQuery(teamRoomsQuery).data ?? []
  return (
    read?.room ??
    (override === null
      ? (team?.room ?? null)
      : (rooms.find((item) => item.id === override) ??
        teamRooms.find((item) => item.id === override) ??
        null))
  )
}

import {
  JobResultsSchema,
  TeamRoomResponseSchema,
  type Job,
  type JobResults,
  type StreamEvent,
  type WatchOverviewItem,
} from '@score/contract'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStream, useStreamQuery } from '../data/query-client.ts'
import { defineStreamQuery } from '../data/resync.ts'
import { useWatchOverview } from '../routes/watch/watch-queries.ts'

type TeamRoom = { room: { id: string; name: string }; jobs: Job[] }

// The room column owns job selection (11.4a). Results only needs the job list, so it keeps its own read of the same
// contract endpoint and follows `job.upserted` until that screen exists.
export const boldTeamRoomQuery = defineStreamQuery<TeamRoom>({
  key: ['bold', 'team-room'],
  async fetch(signal) {
    const { asOfSeq, room, jobs } = TeamRoomResponseSchema.parse(
      await apiFetch('team-room', { signal }),
    )
    return { asOfSeq, data: { room, jobs } }
  },
  types: ['job.upserted', 'room.upserted'],
  reduce(data, event) {
    if (event.type === 'room.upserted' && event.data.id === data.room.id)
      return { ...data, room: event.data }
    if (event.type !== 'job.upserted' || event.data.roomId !== data.room.id) return data
    const rest = data.jobs.filter((job) => job.id !== event.data.id)
    return { ...data, jobs: [...rest, event.data] }
  },
})

const jobResultsKey = (jobId: string) => ['bold', 'job-results', jobId] as const

async function fetchJobResults(jobId: string, signal?: AbortSignal): Promise<JobResults> {
  return JobResultsSchema.parse(
    await apiFetch(`jobs/${encodeURIComponent(jobId)}/results`, { signal }),
  )
}

// Results are derived on read, so events only say "look again". Frames arrive while an agent works; a short delay folds
// a burst into one read without making the panel feel stale.
const REFRESH_MS = 350
const RESULT_EVENTS = new Set<StreamEvent['type']>([
  'job.upserted',
  'exchange.upserted',
  'message.created',
  'message.completed',
  'message.updated',
  'message.deleted',
  'run.updated',
  'watch.frame',
])

export type ResultsJob = { job: Job; result: JobResults }

export function useBoldResults(): {
  jobs: Job[]
  results: ResultsJob[]
  screens: { job: Job; screen: JobResults['screens'][number] }[]
  overview: WatchOverviewItem[] | undefined
  pending: boolean
  failed: boolean
  retry: () => void
} {
  const room = useStreamQuery(boldTeamRoomQuery)
  const jobs = room.data?.jobs ?? []
  const stream = useStream()
  const queryClient = useQueryClient()
  const overview = useWatchOverview()
  const resultQueries = useQueries({
    queries: jobs.map((job) => ({
      queryKey: jobResultsKey(job.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchJobResults(job.id, signal),
      retry: false,
    })),
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey: ['bold', 'team-room'] })
        void queryClient.invalidateQueries({ queryKey: ['bold', 'job-results'] })
      }, REFRESH_MS)
    }
    const offEvents = stream.subscribe((event) => {
      if (RESULT_EVENTS.has(event.type)) refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvents()
      offControl()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [queryClient, stream])

  const results = jobs.flatMap((job, index) => {
    const result = resultQueries[index]?.data
    return result ? [{ job, result }] : []
  })
  return {
    jobs,
    results,
    screens: results.flatMap(({ job, result }) =>
      result.screens.map((screen) => ({ job, screen })),
    ),
    overview: overview.items,
    pending: room.status === 'pending' || resultQueries.some((query) => query.status === 'pending'),
    failed: room.status === 'error' || resultQueries.some((query) => query.status === 'error'),
    retry: () => {
      void queryClient.invalidateQueries({ queryKey: ['bold', 'team-room'] })
      void queryClient.invalidateQueries({ queryKey: ['bold', 'job-results'] })
    },
  }
}

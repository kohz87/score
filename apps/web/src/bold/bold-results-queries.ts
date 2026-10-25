import {
  JobResultsSchema,
  type Job,
  type JobResults,
  type Room,
  type StreamEvent,
  type WatchOverviewItem,
} from '@score/contract'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStream, useStreamQuery } from '../data/query-client.ts'
import { defineStreamQuery } from '../data/resync.ts'
import { useWatchOverview } from '../routes/watch/watch-queries.ts'
import { fetchCompleteTeamRoom } from './bold-job-reads.ts'

export type TeamRoom = { room: Room; jobs: Job[] }

// The room column owns job selection (11.4a). Results only needs the job list, so it keeps its own read of the same
// contract endpoint and follows `job.upserted` until that screen exists.
export const boldTeamRoomQuery = defineStreamQuery<TeamRoom>({
  key: ['bold', 'team-room'],
  async fetch(signal) {
    const { asOfSeq, room, jobs } = await fetchCompleteTeamRoom(signal)
    return { asOfSeq, data: { room, jobs } }
  },
  types: ['job.upserted', 'job.deleted', 'room.upserted'],
  reduce(data, event) {
    if (event.type === 'room.upserted' && event.data.id === data.room.id)
      return { ...data, room: event.data }
    if (event.type === 'job.deleted') {
      if (event.data.roomId !== data.room.id) return data
      return { ...data, jobs: data.jobs.filter((job) => job.id !== event.data.id) }
    }
    if (event.type !== 'job.upserted' || event.data.roomId !== data.room.id) return data
    const rest = data.jobs.filter((job) => job.id !== event.data.id)
    return { ...data, jobs: [...rest, event.data] }
  },
})

export const jobResultsKey = (jobId: string) => ['bold', 'job-results', jobId] as const

async function fetchJobResults(jobId: string, signal?: AbortSignal): Promise<JobResults> {
  return JobResultsSchema.parse(
    await apiFetch(`jobs/${encodeURIComponent(jobId)}/results`, { signal }),
  )
}

// Results are derived on read, so events only say "look again". Streaming replies update per token; `message.updated`
// would turn every token into a read, so only durable job, exchange and watch changes ask for one. A one-second window
// folds a burst (one event or many) into at most one refresh.
const REFRESH_MS = 1000
const RESULT_EVENTS = new Set<StreamEvent['type']>([
  'job.upserted',
  'job.deleted',
  'exchange.upserted',
  'watch.frame',
])

function eventJobId(event: StreamEvent): string | undefined {
  if (event.type === 'job.upserted' || event.type === 'job.deleted') return event.data.id
  if (event.type === 'exchange.upserted') return event.data.jobId
  return undefined
}

export type ResultsJob = { job: Job; result: JobResults }

export function useBoldResults(
  visible = true,
  selectedJobId: string | null = null,
): {
  jobs: Job[]
  results: ResultsJob[]
  screens: { job: Job; screen: JobResults['screens'][number] }[]
  overview: WatchOverviewItem[] | undefined
  pending: boolean
  failed: boolean
  retry: () => void
} {
  const room = useStreamQuery(boldTeamRoomQuery)
  const jobs = (room.data?.jobs ?? []).filter(
    (job) => job.state !== 'closed' && (!selectedJobId || job.id === selectedJobId),
  )
  const stream = useStream()
  const queryClient = useQueryClient()
  const overview = useWatchOverview(visible)
  const resultQueries = useQueries({
    queries: jobs.map((job) => ({
      queryKey: jobResultsKey(job.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchJobResults(job.id, signal),
      retry: false,
      enabled: visible,
    })),
  })

  useEffect(() => {
    if (!visible) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const jobIds = new Set<string>()
    let allResults = false
    let roomWide = false
    const flush = () => {
      timer = undefined
      if (allResults) {
        void queryClient.invalidateQueries({ queryKey: ['bold', 'job-results'] })
      } else {
        for (const jobId of jobIds)
          void queryClient.invalidateQueries({ queryKey: jobResultsKey(jobId), exact: true })
      }
      if (roomWide) void queryClient.invalidateQueries({ queryKey: ['bold', 'team-room'] })
      jobIds.clear()
      allResults = false
      roomWide = false
    }
    const refresh = (event?: StreamEvent) => {
      const jobId = event ? eventJobId(event) : undefined
      if (jobId) jobIds.add(jobId)
      else allResults = true
      timer ??= setTimeout(flush, REFRESH_MS)
    }
    const offEvents = stream.subscribe((event) => {
      if (RESULT_EVENTS.has(event.type)) refresh(event)
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) {
        roomWide = true
        refresh()
      }
    })
    return () => {
      offEvents()
      offControl()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [queryClient, stream, visible])

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

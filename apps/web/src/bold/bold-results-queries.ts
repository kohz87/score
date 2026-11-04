import { JobResultsSchema, type JobResults, type StreamEvent } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStream } from '../data/query-client.ts'

export const jobResultsKey = (jobId: string) => ['bold', 'job-results', jobId] as const

export async function fetchJobResults(jobId: string, signal?: AbortSignal): Promise<JobResults> {
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

/** One topic's Files and results (3.25.0), kept fresh by the stream. The key is the one the room's file links read. */
export function useJobResults(
  jobId: string | null,
  visible = true,
  /** Agents of the topic besides those with a screen in it (the holder, who is busy): their frames count too. */
  agentIds: readonly string[] = [],
): {
  results: JobResults | undefined
  pending: boolean
  failed: boolean
  retry: () => void
} {
  const stream = useStream()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: jobResultsKey(jobId ?? ''),
    queryFn: ({ signal }) => fetchJobResults(jobId!, signal),
    retry: false,
    enabled: visible && jobId !== null,
  })

  // A watch frame is one agent's; only the topic's own agents' frames can change what this topic shows. Read through a
  // ref so a new screen doesn't re-subscribe.
  const screenAgents = new Set([
    ...(query.data?.screens.map((screen) => screen.agentId) ?? []),
    ...agentIds,
  ])
  const watched = useRef(screenAgents)
  useEffect(() => {
    watched.current = screenAgents
  })

  useEffect(() => {
    if (!visible || !jobId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey: jobResultsKey(jobId), exact: true })
      }, REFRESH_MS)
    }
    const offEvents = stream.subscribe((event) => {
      if (!RESULT_EVENTS.has(event.type)) return
      if (event.type === 'watch.frame') {
        if (watched.current.has(event.data.agentId)) refresh()
        return
      }
      if ((eventJobId(event) ?? jobId) === jobId) refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvents()
      offControl()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [jobId, queryClient, stream, visible])

  return {
    results: query.data,
    pending: query.status === 'pending' && query.fetchStatus !== 'idle',
    failed: query.status === 'error',
    retry: () => {
      if (jobId) void queryClient.invalidateQueries({ queryKey: jobResultsKey(jobId), exact: true })
    },
  }
}

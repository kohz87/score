import { WorkbenchSchema, type Workbench } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStream } from '../data/query-client.ts'

const workbenchKey = (jobId: string) => ['bold', 'job-workbench', jobId] as const

async function fetchWorkbench(jobId: string, signal?: AbortSignal): Promise<Workbench> {
  return WorkbenchSchema.parse(
    await apiFetch(`jobs/${encodeURIComponent(jobId)}/workbench`, { signal }),
  )
}

// A Workbench is derived on read, so events only say "look again". The frame event carries no job id, so a frame asks
// for the visible job's Workbench again; everything else names its job. One window folds a burst into one read.
const REFRESH_MS = 1000
const WORKBENCH_EVENTS = new Set([
  'job.upserted',
  'exchange.upserted',
  'watch.frame',
  'approval.requested',
  'approval.updated',
])

export function useBoldWorkbench(
  jobId: string | null,
  visible = true,
): {
  workbench: Workbench | undefined
  pending: boolean
  failed: boolean
  retry: () => void
} {
  const stream = useStream()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: workbenchKey(jobId ?? ''),
    queryFn: ({ signal }) => fetchWorkbench(jobId!, signal),
    retry: false,
    enabled: visible && jobId !== null,
  })

  useEffect(() => {
    if (!visible || !jobId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey: workbenchKey(jobId), exact: true })
      }, REFRESH_MS)
    }
    const offEvents = stream.subscribe((event) => {
      if (!WORKBENCH_EVENTS.has(event.type)) return
      if (event.type === 'job.upserted') {
        if (event.data.id === jobId) refresh()
        return
      }
      if (event.type === 'exchange.upserted') {
        if (event.data.jobId === jobId) refresh()
        return
      }
      if (
        event.type === 'watch.frame' ||
        event.type === 'approval.requested' ||
        event.type === 'approval.updated'
      )
        refresh()
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
    workbench: query.data,
    pending: jobId === null || query.isPending,
    failed: query.isError,
    retry: () => void queryClient.invalidateQueries({ queryKey: workbenchKey(jobId ?? '') }),
  }
}

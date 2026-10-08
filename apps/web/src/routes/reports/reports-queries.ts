import { ReportsSchema, type ReportRange } from '@score/contract'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'

export const reportRanges: { id: ReportRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

const THROTTLE_MS = 5_000
export const reportsKey = (range: ReportRange) => ['reports', range] as const
export const reportCsvHref = (range: ReportRange) => `/api/reports/export.csv?range=${range}`

// Reports are an aggregate read, not on the stream: refetch (throttled) when something that feeds them changes.
export function useReports(range: ReportRange) {
  const stream = useStream()
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: reportsKey(range),
    queryFn: async ({ signal }) =>
      ReportsSchema.parse(await apiFetch(`reports?range=${range}`, { signal })),
    placeholderData: keepPreviousData, // switching range keeps the page up while the new numbers load
    retry: false,
  })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      if (timer) return
      const wait = Math.max(0, last + THROTTLE_MS - Date.now())
      timer = setTimeout(() => {
        timer = undefined
        last = Date.now()
        void queryClient.invalidateQueries({ queryKey: reportsKey(range), exact: true })
      }, wait)
    }
    const offEvent = stream.subscribe((event) => {
      if (
        event.type === 'task.upserted' ||
        event.type.startsWith('run.') ||
        event.type.startsWith('approval.')
      )
        refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvent()
      offControl()
      clearTimeout(timer)
    }
  }, [stream, queryClient, range])
  return query
}

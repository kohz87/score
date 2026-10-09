import { ReportsSchema, type ReportRange } from '@score/contract'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'

export const reportRanges: { id: Exclude<ReportRange, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

/** What a Reports page asks for: a preset, or whole local days (`from`/`to`, YYYY-MM-DD, inclusive). */
export type ReportSpec =
  { range: Exclude<ReportRange, 'custom'> } | { range: 'custom'; from: string; to: string }

export const MAX_CUSTOM_DAYS = 366
const THROTTLE_MS = 5_000
export const reportsKey = (spec: ReportSpec) =>
  spec.range === 'custom'
    ? (['reports', 'custom', spec.from, spec.to] as const)
    : (['reports', spec.range] as const)
const specQuery = (spec: ReportSpec) =>
  spec.range === 'custom' ? `range=custom&from=${spec.from}&to=${spec.to}` : `range=${spec.range}`
// Days are bucketed in the viewer's time zone, not the server's (often UTC).
const viewerZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}
const zoneParam = () => {
  const zone = viewerZone()
  return zone ? `&tz=${encodeURIComponent(zone)}` : ''
}
export const reportCsvHref = (spec: ReportSpec) =>
  `/api/reports/export.csv?${specQuery(spec)}${zoneParam()}`

/** Today's date in the viewer's zone, the latest day a custom range may end on. */
export function viewerToday(now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: viewerZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}
const isDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  // Invalid dates (2026-13-01) make toISOString throw: check the timestamp first.
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
}
const dayCount = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1

/** Why a custom range cannot be applied, or null. The server checks the same rules. */
export function customRangeError(from: string, to: string, today = viewerToday()): string | null {
  if (!isDay(from) || !isDay(to)) return 'Pick both days.'
  if (from > to) return 'The first day must not be after the last day.'
  if (to > today) return 'The last day cannot be after today.'
  if (dayCount(from, to) > MAX_CUSTOM_DAYS) return `Pick at most ${MAX_CUSTOM_DAYS} days.`
  return null
}

// Reports are an aggregate read, not on the stream: refetch (throttled) when something that feeds them changes.
const fetchReport = async (spec: ReportSpec, signal?: AbortSignal) =>
  ReportsSchema.parse(await apiFetch(`reports?${specQuery(spec)}${zoneParam()}`, { signal }))

export function useReports(spec: ReportSpec) {
  const stream = useStream()
  const queryClient = useQueryClient()
  // Callers pass a stable spec (memoised), so the key is stable too.
  const key = useMemo(() => reportsKey(spec), [spec])
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchReport(spec, signal),
    placeholderData: keepPreviousData, // switching range keeps the page up while the new numbers load
    retry: false,
  })
  // Once one range is on screen, warm the other presets so a click shows numbers at once (and refreshes behind them).
  const loaded = query.isSuccess && !query.isPlaceholderData
  useEffect(() => {
    if (!loaded) return
    for (const { id } of reportRanges)
      void queryClient.prefetchQuery({
        queryKey: reportsKey({ range: id }),
        queryFn: () => fetchReport({ range: id }),
        staleTime: 30_000,
      })
  }, [loaded, queryClient])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      if (timer) return
      const wait = Math.max(0, last + THROTTLE_MS - Date.now())
      timer = setTimeout(() => {
        timer = undefined
        last = Date.now()
        void queryClient.invalidateQueries({ queryKey: key, exact: true })
      }, wait)
    }
    const offEvent = stream.subscribe((event) => {
      if (
        event.type === 'task.upserted' ||
        // The agent list comes from Score's projection; on a cold start it fills while this page loads.
        event.type === 'agent.updated' ||
        event.type.startsWith('run.') ||
        event.type === 'attempt.updated' ||
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
  }, [stream, queryClient, key])
  return query
}

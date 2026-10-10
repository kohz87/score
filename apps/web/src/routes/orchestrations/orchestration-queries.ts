import {
  GlobalFenceSchema,
  OrchestrationCreatedSchema,
  OrchestrationEventsSchema,
  OrchestrationListSchema,
  OrchestrationSnapshotSchema,
  OrchestrationSummarySchema,
  PreflightSchema,
  type AbandonDecision,
  type FenceLift,
  type GateDecision,
  type GlobalFence,
  type InquiryAnswer,
  type LimitsDecision,
  type OrchEvent,
  type OrchestrationCreate,
  type OrchestrationDetail,
  type OrchestrationSummary,
  type RunControl,
  type WaiverDecision,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStream } from '../../data/query-client.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { throttle } from '../../data/throttle.ts'

// A burst of changes refetches a run at most this often (first at once, the rest as one trailing refetch).
const REFRESH_MS = 250

/** Every run, newest first; `orchestration.upserted` replaces a run's summary. */
export const orchestrationsQuery = defineStreamQuery<OrchestrationSummary[]>({
  key: ['orchestrations', 'list'],
  async fetch() {
    const list = OrchestrationListSchema.parse(await apiFetch('orchestrations'))
    return { asOfSeq: list.asOfSeq, data: list.items }
  },
  types: ['orchestration.upserted'],
  reduce(items, event) {
    if (event.type !== 'orchestration.upserted') return items
    const next = event.data
    const rest = items.filter((item) => item.id !== next.id)
    return [...rest, next].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
  },
})

export const fenceKey = ['orchestrations', 'fence'] as const

/** The global admission fence (restore or journal problems). */
export function useFence() {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    const offEvent = stream.subscribe((event) => {
      if (event.type === 'orchestration.fence.updated')
        queryClient.setQueryData<GlobalFence>(fenceKey, event.data)
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) void queryClient.invalidateQueries({ queryKey: fenceKey })
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient])
  return useQuery({
    queryKey: fenceKey,
    queryFn: async ({ signal }) =>
      GlobalFenceSchema.parse(await apiFetch('orchestrations/fence', { signal })),
    retry: false,
  })
}

export type RunData = {
  snapshot: { asOfSeq: number; orchestration: OrchestrationDetail }
  events: OrchEvent[]
}
export const runKey = (id: string) => ['orchestrations', 'run', id] as const

/**
 * One run: its snapshot and its event history, read together. Changes arrive as `orchestration.upserted`, which only
 * says "read it again" (the summary has no detail); a snapshot older than an upsert already seen is read again.
 */
export function useRun(id: string | undefined) {
  const stream = useStream()
  const queryClient = useQueryClient()
  const [needSeq, setNeedSeq] = useState(0)
  useEffect(() => {
    if (!id) return
    const refresh = throttle(
      () => void queryClient.invalidateQueries({ queryKey: runKey(id), exact: true }),
      REFRESH_MS,
    )
    const offEvent = stream.subscribe((event) => {
      if (event.type === 'orchestration.upserted' && event.data.id === id) {
        setNeedSeq((seq) => Math.max(seq, event.seq))
        refresh()
      }
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) {
        // A new stream epoch restarts the sequence: older upserts say nothing about the new numbering.
        setNeedSeq(0)
        refresh()
      }
    })
    return () => {
      offEvent()
      offControl()
      refresh.cancel()
    }
  }, [stream, queryClient, id])
  const query = useQuery({
    queryKey: runKey(id ?? ''),
    enabled: id !== undefined,
    queryFn: async ({ signal }): Promise<RunData> => {
      const path = `orchestrations/${encodeURIComponent(id!)}`
      const [snapshot, events] = await Promise.all([
        apiFetch(path, { signal }).then((value) => OrchestrationSnapshotSchema.parse(value)),
        apiFetch(`${path}/events`, { signal }).then((value) =>
          OrchestrationEventsSchema.parse(value),
        ),
      ])
      return { snapshot, events: events.events }
    },
    retry: false,
  })
  // The read raced an update (its asOfSeq is older than an upsert already seen): read once more.
  const behind = query.data !== undefined && query.data.snapshot.asOfSeq < needSeq
  const refetch = query.refetch
  const retries = useRef(0)
  useEffect(() => {
    if (!behind) retries.current = 0
    // Bounded: a read that stays behind (an unexpected sequence) must not loop.
    if (behind && !query.isFetching && retries.current < 3) {
      retries.current += 1
      const timer = setTimeout(() => void refetch(), REFRESH_MS)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [behind, query.isFetching, query.dataUpdatedAt, refetch])
  return query
}

export function usePreflight(leadAgentId: string, allowedAgents: string[]) {
  const key = allowedAgents.join(',')
  return useQuery({
    queryKey: ['orchestrations', 'preflight', leadAgentId, key],
    enabled: leadAgentId !== '',
    queryFn: async ({ signal }) =>
      PreflightSchema.parse(
        await apiFetch(
          `orchestrations/preflight?${new URLSearchParams({ leadAgentId, allowedAgents: key })}`,
          { signal },
        ),
      ),
    retry: false,
    staleTime: 0,
  })
}

const post = (path: string, body: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify(body),
  })

export function useCreateOrchestration() {
  return useMutation({
    mutationFn: async (body: OrchestrationCreate) =>
      OrchestrationCreatedSchema.parse(await post('orchestrations', body)),
  })
}

/** A stale page (409 conflict) shows what changed and lets the person decide again; everything else is plain. */
export function describeOrchError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'That did not work. Please try again.'
  if (error.code === 'conflict')
    return 'This changed while you were looking. The page now shows the latest; check it and decide again.'
  if (error.code === 'orchestration_owned')
    return 'This room belongs to a running orchestration. Use the run controls instead.'
  return error.message
}

export type RunActions = ReturnType<typeof useRunActions>

function useRunPost<V>(id: string, build: (variables: V) => { path: string; body: unknown }) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (variables: V) => {
      const { path, body } = build(variables)
      return OrchestrationSummarySchema.parse(
        await post(`orchestrations/${encodeURIComponent(id)}/${path}`, body),
      )
    },
    // Also after a failure: a conflict means the run moved on.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: runKey(id), exact: true })
    },
  })
}
const plain =
  <B>(path: string) =>
  (body: B) => ({ path, body })

export function useRunActions(id: string) {
  return {
    gate: useRunPost<{ gateId: string; body: GateDecision }>(id, (v) => ({
      path: `gates/${encodeURIComponent(v.gateId)}/decision`,
      body: v.body,
    })),
    inquiry: useRunPost<{ inquiryId: string; body: InquiryAnswer }>(id, (v) => ({
      path: `inquiries/${encodeURIComponent(v.inquiryId)}/answer`,
      body: v.body,
    })),
    limits: useRunPost<LimitsDecision>(id, plain('limits')),
    pause: useRunPost<RunControl>(id, plain('pause')),
    resume: useRunPost<RunControl>(id, plain('resume')),
    stop: useRunPost<RunControl>(id, plain('stop')),
    waiver: useRunPost<WaiverDecision>(id, plain('waiver')),
    abandon: useRunPost<AbandonDecision>(id, plain('abandon')),
  }
}

export function useLiftFence() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: FenceLift) =>
      GlobalFenceSchema.parse(await post('orchestrations/fence/lift', body)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: fenceKey })
      void queryClient.invalidateQueries({ queryKey: ['orchestrations'] })
    },
  })
}

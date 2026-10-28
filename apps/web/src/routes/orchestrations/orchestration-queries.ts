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
  type PolicyRemapDecision,
  type QuotaDecision,
  type RunControl,
  type RemapDecision,
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
  async fetch(signal) {
    const list = OrchestrationListSchema.parse(await apiFetch('orchestrations', { signal }))
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
 * One run's data kept live: `load` reads the snapshot and the event history together; the stream's upsert for this
 * run only says "read it again" (the summary has no detail), and a snapshot older than an upsert already seen is read
 * again. Shared by orchestration runs and workflow runs (7.1b), which differ only in the event type, key and loader.
 */
export function useLiveRun<T extends { snapshot: { asOfSeq: number } }>(options: {
  id: string | undefined
  type: 'orchestration.upserted' | 'workflow.run.upserted'
  key: readonly unknown[]
  load: (id: string, signal: AbortSignal) => Promise<T>
}) {
  const { id, type, key, load } = options
  const stream = useStream()
  const queryClient = useQueryClient()
  const [needSeq, setNeedSeq] = useState(0)
  useEffect(() => {
    if (!id) return
    const refresh = throttle(
      () => void queryClient.invalidateQueries({ queryKey: key, exact: true }),
      REFRESH_MS,
    )
    const offEvent = stream.subscribe((event) => {
      if (event.type === type && (event.data as { id: string }).id === id) {
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
    // `key` is rebuilt on every render from `id`; only `id` and `type` identify the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, queryClient, id, type])
  const query = useQuery({
    queryKey: key,
    enabled: id !== undefined,
    queryFn: ({ signal }) => load(id!, signal),
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

/** One orchestration: its snapshot and its event history. */
export function useRun(id: string | undefined) {
  return useLiveRun<RunData>({
    id,
    type: 'orchestration.upserted',
    key: runKey(id ?? ''),
    load: async (runId, signal) => {
      const path = `orchestrations/${encodeURIComponent(runId)}`
      const [snapshot, events] = await Promise.all([
        apiFetch(path, { signal }).then((value) => OrchestrationSnapshotSchema.parse(value)),
        apiFetch(`${path}/events`, { signal }).then((value) =>
          OrchestrationEventsSchema.parse(value),
        ),
      ])
      return { snapshot, events: events.events }
    },
  })
}

/** The create body as the screens build it: `advisorMode` is retired (3.14.1) and never sent. */
export type OrchestrationCreateBody = Omit<OrchestrationCreate, 'advisorMode'> &
  Partial<Pick<OrchestrationCreate, 'advisorMode'>>

export async function fetchPreflight(
  leadAgentId: string,
  allowedAgents: string[],
  signal?: AbortSignal,
) {
  return PreflightSchema.parse(
    await apiFetch(
      `orchestrations/preflight?${new URLSearchParams({ leadAgentId, allowedAgents: allowedAgents.join(',') })}`,
      signal ? { signal } : {},
    ),
  )
}

export function usePreflight(leadAgentId: string, allowedAgents: string[]) {
  const key = allowedAgents.join(',')
  return useQuery({
    queryKey: ['orchestrations', 'preflight', leadAgentId, key],
    enabled: leadAgentId !== '',
    queryFn: ({ signal }) => fetchPreflight(leadAgentId, allowedAgents, signal),
    retry: false,
    staleTime: 0,
  })
}

export const post = (path: string, body: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify(body),
  })

export function useCreateOrchestration() {
  return useMutation({
    mutationFn: async (body: OrchestrationCreateBody) =>
      OrchestrationCreatedSchema.parse(await post('orchestrations', body)),
  })
}

/** A stale page (409 conflict) shows what changed and lets the person decide again; everything else is plain. */
export function describeOrchError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Couldn’t do that. Try again.'
  if (error.code === 'conflict')
    return 'This changed while you were looking. The page now shows the latest. Check it and decide again.'
  if (error.code === 'orchestration_owned')
    return 'This room belongs to a running orchestration. Use the run controls instead.'
  if (error.code === 'stale_plan')
    return 'What would be re-created changed while you were looking. The page now shows the new plan. Check it and decide again.'
  if (error.code === 'not_retryable')
    return 'This step can’t be retried any more (no tries left, or it moved on). The page now shows where it is.'
  if (error.code === 'policy_changed')
    return 'The agent’s settings changed again while you were looking. The page now shows the latest. Check them and decide again.'
  if (error.code === 'reach_not_acknowledged')
    return 'Accept what the agent can read before you go on.'
  if (error.code === 'not_open')
    return 'That isn’t waiting for a decision any more. The page now shows where the run is.'
  return error.message
}

export type RunActions = ReturnType<typeof useRunActions>

/** What a decision card needs from a mutation; orchestration and workflow runs both satisfy it (7.1b). */
export type Act<V> = {
  mutate: (variables: V) => void
  isPending: boolean
  error: unknown
  /** The variables of the latest call (TanStack's mutation result has them). */
  variables?: V | undefined
}
export type DecisionActions = {
  gate: Act<{ gateId: string; body: GateDecision }>
  limits: Act<LimitsDecision>
  pause: Act<RunControl>
  resume: Act<RunControl>
  stop: Act<RunControl>
  waiver: Act<WaiverDecision>
  abandon: Act<AbandonDecision>
}

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
    remap: useRunPost<RemapDecision>(id, plain('remap')),
    policyRemap: useRunPost<{ stepId: string; body: PolicyRemapDecision }>(id, (v) => ({
      path: `steps/${encodeURIComponent(v.stepId)}/remap`,
      body: v.body,
    })),
    // 3.14: stop one step; the lead is told and can reassign the work.
    stopStep: useRunPost<{ stepId: string; body: RunControl }>(id, (v) => ({
      path: `steps/${encodeURIComponent(v.stepId)}/stop`,
      body: v.body,
    })),
    quota: useRunPost<{ stepId: string; body: QuotaDecision }>(id, (v) => ({
      path: `steps/${encodeURIComponent(v.stepId)}/quota`,
      body: v.body,
    })),
    abandon: useRunPost<AbandonDecision>(id, plain('abandon')),
    // 3.13: the oracle. Both need the run's revision, like pause and resume.
    checkRun: useRunPost<RunControl>(id, plain('check/run')),
    checkWaive: useRunPost<RunControl>(id, plain('check/waive')),
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

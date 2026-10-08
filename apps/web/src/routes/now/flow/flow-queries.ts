import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  BriefFlowSchema,
  BriefSummarySchema,
  BriefsListSchema,
  BriefLogPageSchema,
  FlowNodeDetailSchema,
  NodeStopResponseSchema,
} from '@score/contract'
import { apiFetch } from '../../../data/api.ts'
import { useStream } from '../../../data/query-client.ts'

export const briefListKey = (status: 'active' | 'recent') => ['flow', 'briefs', status] as const
export const briefFlowKey = (briefId: string) => ['flow', 'brief', briefId] as const

export function useBriefLists() {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['flow', 'briefs'] })
    const offEvent = stream.subscribe((event) => {
      if (event.type === 'brief.upserted') refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient])
  const list = (status: 'active' | 'recent') => ({
    queryKey: briefListKey(status),
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      BriefsListSchema.parse(await apiFetch(`briefs?status=${status}`, { signal })).items,
  })
  return { active: useQuery(list('active')), recent: useQuery(list('recent')) }
}

// The flow is a derived graph, not a stream snapshot: refetch it when anything that can change it arrives.
export function useBriefFlow(briefId: string | undefined) {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!briefId) return
    const refresh = () =>
      void queryClient
        .cancelQueries({ queryKey: briefFlowKey(briefId) })
        .then(() => queryClient.invalidateQueries({ queryKey: briefFlowKey(briefId) }))
    const offEvent = stream.subscribe((event) => {
      if (
        (event.type === 'brief.upserted' && event.data.id === briefId) ||
        (event.type === 'handoff.created' &&
          (event.data.briefId === briefId || event.data.briefId === null)) ||
        event.type === 'task.upserted' ||
        event.type === 'run.updated' ||
        event.type === 'message.created' ||
        event.type === 'message.delta' ||
        event.type === 'message.completed' ||
        event.type === 'approval.requested' ||
        event.type === 'approval.updated' ||
        event.type === 'task.activity' ||
        event.type === 'log.line' ||
        event.type === 'lane.upserted' ||
        event.type === 'gap.recorded'
      )
        refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient, briefId])
  return useQuery({
    queryKey: briefFlowKey(briefId ?? ''),
    enabled: briefId !== undefined,
    queryFn: async ({ signal }) =>
      BriefFlowSchema.parse(
        await apiFetch(`briefs/${encodeURIComponent(briefId!)}/flow`, { signal }),
      ),
    retry: false,
  })
}

export function useBriefRunControl(briefId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (action: 'pause' | 'resume') =>
      BriefSummarySchema.parse(
        await apiFetch(`briefs/${encodeURIComponent(briefId)}/${action}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: briefFlowKey(briefId), exact: true }),
        queryClient.invalidateQueries({ queryKey: ['flow', 'briefs'] }),
      ])
    },
  })
}

export function useFlowNode(briefId: string, nodeId: string | null) {
  return useQuery({
    queryKey: [...briefFlowKey(briefId), 'node', nodeId],
    enabled: nodeId !== null,
    queryFn: async ({ signal }) =>
      FlowNodeDetailSchema.parse(
        await apiFetch(`flow/nodes/${encodeURIComponent(nodeId!)}`, { signal }),
      ),
    retry: false,
  })
}

export function useBriefLog(briefId: string, filter: string) {
  return useInfiniteQuery({
    queryKey: [...briefFlowKey(briefId), 'log', filter],
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }) => {
      const params = new URLSearchParams()
      if (filter === 'tool') params.set('kind', 'tool')
      else if (filter !== 'all') params.set('agent', filter.slice(6))
      if (pageParam) params.set('cursor', pageParam)
      return BriefLogPageSchema.parse(
        await apiFetch(`briefs/${encodeURIComponent(briefId)}/log?${params}`, { signal }),
      )
    },
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  })
}

export function useStopFlowNode(briefId: string, nodeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      NodeStopResponseSchema.parse(
        await apiFetch(`flow/nodes/${encodeURIComponent(nodeId)}/stop`, {
          method: 'POST',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: briefFlowKey(briefId) }),
  })
}

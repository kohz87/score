import {
  AgentSummarySchema,
  WatchOverviewSchema,
  WatchResponseSchema,
  type WatchOverviewItem,
  type WatchResponse,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { useStream } from '../../data/query-client.ts'
import { addMarker, surfaceMarker, upsertFrame } from './watch-model.ts'
import { newId } from '../../data/ids.ts'

export type WatchData = Omit<WatchResponse, 'asOfSeq'>
const ACTIVE_RUN = ['queued', 'running', 'waiting_for_approval']

// Frames are upserted by seq (a terminal frame is re-emitted when it finishes); markers follow the frames.
export function watchQuery(agentId: string) {
  return defineStreamQuery<WatchData>({
    key: ['watch', agentId],
    async fetch() {
      const { asOfSeq, ...data } = WatchResponseSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/watch?limit=500`),
      )
      return { asOfSeq, data }
    },
    types: ['watch.frame', 'agent.updated', 'run.updated', 'approval.requested'],
    reduce(data, event) {
      switch (event.type) {
        case 'watch.frame': {
          if (event.data.agentId !== agentId) return data
          const frame = event.data
          return {
            ...data,
            frames: upsertFrame(data.frames, frame),
            markers: addMarker(data.markers, {
              seq: frame.seq,
              at: frame.at,
              kind: surfaceMarker[frame.surface],
            }),
          }
        }
        case 'agent.updated':
          return event.data.id === agentId ? { ...data, agent: event.data } : data
        case 'run.updated':
          return event.data.agentId === agentId
            ? { ...data, live: ACTIVE_RUN.includes(event.data.status) }
            : data
        case 'approval.requested': {
          const last = data.frames.at(-1)
          if (event.data.agentId !== agentId || !last) return data
          // A question lands on the frame that was on screen when it was asked.
          const frame = [...data.frames].reverse().find((item) => item.at <= event.data.createdAt)
          return {
            ...data,
            markers: addMarker(data.markers, {
              seq: (frame ?? last).seq,
              at: event.data.createdAt,
              kind: 'asked',
            }),
          }
        }
        default:
          return data
      }
    },
  })
}

// The overview is a read model (thumbnails and what each agent is doing), so frames only say "read it again".
export function useWatchOverview(): {
  items: WatchOverviewItem[] | undefined
  isError: boolean
} {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey: ['watch-overview'] })
      }, 1000)
    }
    const offEvents = stream.subscribe((event) => {
      if (event.type === 'watch.frame' || event.type === 'agent.updated') refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvents()
      offControl()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [stream, queryClient])
  const query = useQuery({
    queryKey: ['watch-overview'],
    queryFn: async ({ signal }) =>
      WatchOverviewSchema.parse(await apiFetch('watch/overview', { signal })).items,
    retry: false,
  })
  return { items: query.data, isError: query.isError }
}

export function useAgentPause(agentId: string) {
  return useMutation({
    mutationFn: async (action: 'pause' | 'resume') =>
      AgentSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/${action}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: '{}',
        }),
      ),
  })
}

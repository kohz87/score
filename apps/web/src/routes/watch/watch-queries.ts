import {
  ApprovalsPageSchema,
  AgentSummarySchema,
  type Approval,
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
// `from` anchors the frame window at a moment (older replays); null is the newest 500 frames.
export function watchQuery(agentId: string, from: number | null = null) {
  return defineStreamQuery<WatchData>({
    key: ['watch', agentId, from],
    async fetch() {
      const { asOfSeq, ...data } = WatchResponseSchema.parse(
        await apiFetch(
          `agents/${encodeURIComponent(agentId)}/watch?limit=500${from === null ? '' : `&from=${from}`}`,
        ),
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
            frames: upsertFrame(data.frames, frame, from === null ? 'newest' : 'oldest'),
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

// Every approval this agent is still waiting on, however old: the shared newest-50 list can push one out.
export function pendingApprovalsQuery(agentId: string) {
  return defineStreamQuery<Approval[]>({
    key: ['watch', 'pending-approvals', agentId],
    async fetch() {
      const items: Approval[] = []
      let cursor: string | null = null
      let asOfSeq = 0
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ status: 'pending', agent: agentId })
        if (cursor) params.set('cursor', cursor)
        const result = ApprovalsPageSchema.parse(await apiFetch(`approvals?${params}`))
        // The first page fixes the snapshot point; later events replay on top of it.
        if (page === 0) asOfSeq = result.asOfSeq
        items.push(...result.items)
        cursor = result.nextCursor
        if (!cursor) break
      }
      return { asOfSeq, data: items }
    },
    types: ['approval.requested', 'approval.updated'],
    reduce(data, event) {
      if (event.type !== 'approval.requested' && event.type !== 'approval.updated') return data
      const approval = event.data
      if (approval.agentId !== agentId) return data
      const rest = data.filter((item) => item.id !== approval.id)
      return approval.status === 'pending' ? [approval, ...rest] : rest
    },
  })
}

/** The session the agent is on right now, read fresh because run events do not carry it. */
export async function fetchCurrentSession(agentId: string): Promise<string | null> {
  const { sessionId } = WatchResponseSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/watch?limit=1`),
  )
  return sessionId
}

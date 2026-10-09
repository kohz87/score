import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BriefFlowSchema } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'
import { throttle } from '../../data/throttle.ts'
import { briefFlowKey, useBriefLists } from '../now/flow/flow-queries.ts'

const MAX_BRIEFS = 6
const busy = new Set(['working', 'needs_you'])

/**
 * The step this agent is working on now (or waiting on you for), across the active runs. The flows are the same
 * cached queries the Flow view uses, so a pop-out beside Score costs no extra reads.
 */
export function useAgentStep(agentId: string) {
  const stream = useStream()
  const queryClient = useQueryClient()
  const { active } = useBriefLists()
  const briefs = (active.data ?? []).slice(0, MAX_BRIEFS)
  const flows = useQueries({
    queries: briefs.map((brief) => ({
      queryKey: briefFlowKey(brief.id),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        BriefFlowSchema.parse(
          await apiFetch(`briefs/${encodeURIComponent(brief.id)}/flow`, { signal }),
        ),
      retry: false,
    })),
  })
  useEffect(() => {
    const refresh = throttle(
      () => void queryClient.invalidateQueries({ queryKey: ['flow', 'brief'] }),
      1000,
    )
    const off = stream.subscribe((event) => {
      if (
        event.type === 'run.updated' ||
        event.type === 'task.upserted' ||
        event.type === 'approval.requested' ||
        event.type === 'approval.updated' ||
        event.type === 'brief.upserted'
      )
        refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      off()
      offControl()
      refresh.cancel()
    }
  }, [stream, queryClient])
  for (const flow of flows) {
    const node = flow.data?.nodes.find(
      (item) => item.kind === 'step' && item.agentId === agentId && busy.has(item.state),
    )
    if (flow.data && node)
      return {
        loading: false,
        step: { briefId: flow.data.brief.id, roomId: flow.data.brief.roomId, nodeId: node.id },
      }
  }
  return { loading: active.isPending || flows.some((flow) => flow.isPending), step: null }
}

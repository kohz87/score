import { AgentDetailSchema, AgentSummarySchema } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'
import { defineStreamQuery } from '../../data/resync.ts'

// The web app has no direct zod dependency; extend an empty pick of a contract schema instead.
const AgentsSchema = AgentSummarySchema.pick({}).extend({
  // A fresh server has seq 0, which the envelope's (positive) seq rejects; reuse a plain non-negative int.
  asOfSeq: AgentDetailSchema.shape.helpersMax.unwrap(),
  items: AgentSummarySchema.array(),
})

export const agentsQuery = defineStreamQuery({
  key: ['team', 'agents'],
  async fetch() {
    const snapshot = AgentsSchema.parse(await apiFetch('agents'))
    return { asOfSeq: snapshot.asOfSeq, data: snapshot.items }
  },
  types: ['agent.updated'],
  reduce(agents, event) {
    if (event.type !== 'agent.updated') return agents
    return agents.some((agent) => agent.id === event.data.id)
      ? agents.map((agent) => (agent.id === event.data.id ? event.data : agent))
      : [...agents, event.data]
  },
})

export function useAgentDetail(agentId: string) {
  const stream = useStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['team', 'detail', agentId], exact: true })
    }
    const offEvent = stream.subscribe((event) => {
      if (event.type === 'agent.updated' && event.data.id === agentId) refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient, agentId])
  return useQuery({
    queryKey: ['team', 'detail', agentId],
    queryFn: async ({ signal }) =>
      AgentDetailSchema.parse(await apiFetch(`agents/${encodeURIComponent(agentId)}`, { signal })),
    retry: false,
  })
}

export const statusLabels = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs you',
  paused: 'Paused',
  offline: 'Offline',
  'up-next': 'Up next',
} as const

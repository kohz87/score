import { AgentContextSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

/** The agent's own model, read for the context bar and This chat (one cache entry for both). */
export function useAgentModel(agentId: string | null) {
  return useQuery({
    queryKey: ['chat', 'context', 'bar-model', agentId],
    enabled: Boolean(agentId),
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      AgentContextSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId!)}/context`, { signal }),
      ).model,
  }).data
}

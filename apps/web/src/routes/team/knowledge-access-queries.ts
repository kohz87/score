import { KnowledgeAgentAccessSchema } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

const key = (agentId: string) => ['team', 'knowledge-access', agentId] as const
const path = (agentId: string) => `agents/${encodeURIComponent(agentId)}/knowledge`

export function useKnowledgeAccess(agentId: string) {
  return useQuery({
    queryKey: key(agentId),
    queryFn: async ({ signal }) =>
      KnowledgeAgentAccessSchema.parse(await apiFetch(path(agentId), { signal })),
    retry: false,
  })
}

export function useSetKnowledgeAccess(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (enabled: boolean) =>
      KnowledgeAgentAccessSchema.parse(
        await apiFetch(path(agentId), { method: 'PUT', body: JSON.stringify({ enabled }) }),
      ),
    onSuccess: (data) => queryClient.setQueryData(key(agentId), data),
  })
}

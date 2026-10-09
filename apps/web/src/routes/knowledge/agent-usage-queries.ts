import { KnowledgeAgentUsageSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { knowledgeKey } from './knowledge-queries.ts'

export function useKnowledgeAgentUsage() {
  return useQuery({
    queryKey: [...knowledgeKey, 'agent-usage'] as const,
    queryFn: async ({ signal }) =>
      KnowledgeAgentUsageSchema.parse(await apiFetch('knowledge/agent-usage', { signal })),
    retry: false,
  })
}

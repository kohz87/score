import {
  CodingAgentSchema,
  CodingAgentsResponseSchema,
  CodingRuntimesResponseSchema,
  type CodingAgent,
} from '@score/contract'
import { useMutation, useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

export const codingRuntimesQuery = {
  queryKey: ['coding', 'runtimes'],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    CodingRuntimesResponseSchema.parse(await apiFetch('coding-agents/runtimes', { signal })).items,
}
export const codingAgentsQuery = {
  queryKey: ['coding', 'agents'],
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    CodingAgentsResponseSchema.parse(await apiFetch('coding-agents', { signal })).items,
}

/** The coding record (its floor and model) of one agent; null until the list is here or when it is not a coding agent. */
export function useCodingAgent(agentId: string) {
  return useQuery(codingAgentsQuery).data?.find((agent) => agent.id === agentId)
}

/** Like `useCodingAgent`, but says whether the list is still loading or couldn't be read (a floor is then unknown). */
export function useCodingAgentState(agentId: string): {
  agent: CodingAgent | undefined
  status: 'loading' | 'error' | 'ready'
} {
  const query = useQuery(codingAgentsQuery)
  const agent = query.data?.find((item) => item.id === agentId)
  if (query.isError) return { agent: undefined, status: 'error' }
  return { agent, status: query.isPending ? 'loading' : 'ready' }
}

export function useCodingPatch(coding: CodingAgent, onChanged: () => void, done: () => void) {
  return useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      CodingAgentSchema.parse(
        await apiFetch(`coding-agents/${encodeURIComponent(coding.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }),
      ),
    onSuccess: () => {
      onChanged()
      done()
    },
  })
}

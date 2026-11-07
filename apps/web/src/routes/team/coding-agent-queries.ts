import {
  CodingAgentSchema,
  CodingAgentsResponseSchema,
  CodingRuntimesResponseSchema,
  type CodingAgent,
} from '@score/contract'
import { useMutation } from '@tanstack/react-query'
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

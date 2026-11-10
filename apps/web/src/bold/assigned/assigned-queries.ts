import { AgentAssignedSchema, type AgentAssigned } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

// TR.4 (decision 183): what is assigned to one agent, read-only here (it is set in Tasks). Not in the stream, so a plain
// fetch; the Tasks board's own task list is the other half and comes from allTasksQuery.
export const assignedKey = (agentId: string) => ['bold', 'assigned', agentId] as const

export async function fetchAssigned(agentId: string, signal?: AbortSignal): Promise<AgentAssigned> {
  return AgentAssignedSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/assigned`, {
      ...(signal ? { signal } : {}),
    }),
  )
}

export function useAgentAssigned(agentId: string) {
  return useQuery({
    queryKey: assignedKey(agentId),
    queryFn: ({ signal }) => fetchAssigned(agentId, signal),
    retry: false,
  })
}

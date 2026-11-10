import { RoutineSummarySchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

// Not in the stream, so these reads are plain fetches that mutations invalidate.
const RoutineListSchema = RoutineSummarySchema.array()
export const routinesKey = (agentId: string) => ['team', 'routines', agentId] as const

/** One agent's routines, shared by Team › Routines and the bold Start a job dialog. */
export async function fetchRoutines(agentId: string, signal?: AbortSignal) {
  const body = await apiFetch(`agents/${encodeURIComponent(agentId)}/routines`, {
    ...(signal ? { signal } : {}),
  })
  const items = typeof body === 'object' && body !== null && 'items' in body ? body.items : null
  return RoutineListSchema.parse(items)
}

export function useRoutines(agentId: string) {
  return useQuery({
    queryKey: routinesKey(agentId),
    queryFn: ({ signal }) => fetchRoutines(agentId, signal),
    retry: false,
  })
}

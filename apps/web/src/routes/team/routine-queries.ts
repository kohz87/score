import { RoutineSummarySchema } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

// Not in the stream, so these reads are plain fetches that mutations invalidate.
const RoutineListSchema = RoutineSummarySchema.array()
const routinesKey = (agentId: string) => ['team', 'routines', agentId] as const

export interface NewRoutine {
  title: string
  schedule: string
  prompt: string
}

export function useRoutines(agentId: string) {
  return useQuery({
    queryKey: routinesKey(agentId),
    queryFn: async ({ signal }) => {
      const body = await apiFetch(`agents/${encodeURIComponent(agentId)}/routines`, { signal })
      const items = typeof body === 'object' && body !== null && 'items' in body ? body.items : null
      return RoutineListSchema.parse(items)
    },
    retry: false,
  })
}

export function useRoutineActions(agentId: string) {
  const queryClient = useQueryClient()
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: routinesKey(agentId), exact: true }),
      // The Overview card reads the routines inside the agent detail.
      queryClient.invalidateQueries({ queryKey: ['team', 'detail', agentId], exact: true }),
    ])
  }
  const create = useMutation({
    mutationFn: async ({ routine, key }: { routine: NewRoutine; key: string }) =>
      RoutineSummarySchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/routines`, {
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          body: JSON.stringify(routine),
        }),
      ),
    onSuccess: refresh,
  })
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      RoutineSummarySchema.parse(
        await apiFetch(`routines/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: refresh,
  })
  const run = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`routines/${encodeURIComponent(id)}/run`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
      })
    },
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`routines/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': newId() },
      })
    },
    onSuccess: refresh,
  })
  return { create, toggle, run, remove }
}

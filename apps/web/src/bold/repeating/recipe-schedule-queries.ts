import {
  RecipeScheduleSchema,
  RecipeSchedulesResponseSchema,
  type RecipeSchedule,
  type RecipeScheduleRequest,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

export const recipeSchedulesKey = ['bold', 'recipe-schedules'] as const

const path = (workflowId: string) => `workflows/${encodeURIComponent(workflowId)}/schedule`

/** `GET /api/recipe-schedules` (decision 183): every recipe that repeats. */
export function useRecipeSchedules() {
  return useQuery({
    queryKey: recipeSchedulesKey,
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }): Promise<RecipeSchedule[]> =>
      RecipeSchedulesResponseSchema.parse(await apiFetch('recipe-schedules', { signal })).items,
  })
}

/** The schedule of one recipe, or null when it doesn't repeat. */
export function useRecipeSchedule(workflowId: string) {
  const query = useRecipeSchedules()
  return { ...query, schedule: query.data?.find((item) => item.workflowId === workflowId) ?? null }
}

/** Set (or replace), Run now and Stop for one recipe's schedule. Each refreshes the schedules. */
export function useRecipeScheduleActions(workflowId: string) {
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: recipeSchedulesKey })
  }
  const save = useMutation({
    mutationFn: async (body: RecipeScheduleRequest) =>
      RecipeScheduleSchema.parse(
        await apiFetch(path(workflowId), { method: 'PUT', body: JSON.stringify(body) }),
      ),
    onSuccess: refresh,
  })
  const runNow = useMutation({
    mutationFn: async () =>
      RecipeScheduleSchema.parse(
        await apiFetch(`${path(workflowId)}/run`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({}),
        }),
      ),
    // The run it starts reaches the recipe's runs through workflow.run.upserted.
    onSuccess: refresh,
  })
  const stop = useMutation({
    // The answer is only `{ workflowId }`; the refetch shows the recipe without a schedule.
    mutationFn: async () => {
      await apiFetch(path(workflowId), { method: 'DELETE' })
    },
    onSuccess: refresh,
  })
  return { save, runNow, stop }
}

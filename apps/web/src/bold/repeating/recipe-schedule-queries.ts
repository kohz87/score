import {
  RecipeScheduleSchema,
  RecipeSchedulesResponseSchema,
  type RecipeSchedule,
  type RecipeScheduleRequest,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useWorkflow, useWorkflowPreflight } from '../../routes/workflows/workflow-queries.ts'

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
        await apiFetch(path(workflowId), {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(body),
        }),
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
      await apiFetch(path(workflowId), {
        method: 'DELETE',
        headers: { 'Idempotency-Key': newId() },
      })
    },
    onSuccess: refresh,
  })
  return { save, runNow, stop }
}

/**
 * What a schedule is bound to (decision 183): the agents the recipe's latest version would run with now, as the start
 * screen shows them. Null while it loads or when the recipe can't be checked.
 */
export function useScheduleBinding(workflowId: string): {
  agentMap: RecipeScheduleRequest['agentMap'] | null
  checking: boolean
} {
  const recipe = useWorkflow(workflowId)
  const preflight = useWorkflowPreflight(workflowId, recipe.data?.latestVersion)
  return {
    agentMap:
      preflight.data?.mapping.map(({ agentId, incarnation }) => ({ agentId, incarnation })) ?? null,
    checking: recipe.isPending || preflight.isPending,
  }
}

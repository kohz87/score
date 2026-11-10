import {
  MovedRepeatingJobSchema,
  RecipeScheduleSchema,
  RecipeSchedulesResponseSchema,
  RepeatingJobSchema,
  RepeatingJobsResponseSchema,
  type CreateRepeatingJob,
  type PatchRepeatingJob,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

// Contract section 22. Neither list is on the stream, so these are plain reads that every change invalidates.
export const repeatingKey = ['bold', 'repeating', 'jobs'] as const
export const recipeSchedulesKey = ['bold', 'repeating', 'recipe-schedules'] as const

export function useRepeatingJobs() {
  return useQuery({
    queryKey: repeatingKey,
    retry: false,
    queryFn: async ({ signal }) =>
      RepeatingJobsResponseSchema.parse(await apiFetch('routines', { signal })),
  })
}

export function useRecipeSchedules() {
  return useQuery({
    queryKey: recipeSchedulesKey,
    retry: false,
    queryFn: async ({ signal }) =>
      RecipeSchedulesResponseSchema.parse(await apiFetch('recipe-schedules', { signal })),
  })
}

const enc = encodeURIComponent
// Every change carries its own Idempotency-Key, as the agent page's routine controls always did: a retried request is
// answered once.
const send = (method: string, body?: unknown, key = true): RequestInit => ({
  method,
  ...(key ? { headers: { 'Idempotency-Key': newId() } } : {}),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

export function useRepeatingActions() {
  const client = useQueryClient()
  // The agent page's card and the Overview read the same jobs under their own keys.
  const refresh = async (...agentIds: string[]) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: repeatingKey }),
      client.invalidateQueries({ queryKey: recipeSchedulesKey }),
      ...agentIds.flatMap((id) => [
        client.invalidateQueries({ queryKey: ['team', 'routines', id], exact: true }),
        client.invalidateQueries({ queryKey: ['team', 'detail', id], exact: true }),
        client.invalidateQueries({ queryKey: ['bold', 'assigned', id], exact: true }),
      ]),
    ])
  }
  const create = useMutation({
    mutationFn: async ({ agentId, body }: { agentId: string; body: CreateRepeatingJob }) =>
      RepeatingJobSchema.parse(
        await apiFetch(`agents/${enc(agentId)}/routines`, send('POST', body, true)),
      ),
    onSuccess: (job) => refresh(job.agentId),
  })
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: PatchRepeatingJob }) =>
      RepeatingJobSchema.parse(await apiFetch(`routines/${enc(id)}`, send('PATCH', body))),
    onSuccess: (job) => refresh(job.agentId),
  })
  const move = useMutation({
    mutationFn: async ({ id, agentId }: { id: string; agentId: string; from: string }) =>
      MovedRepeatingJobSchema.parse(
        await apiFetch(`routines/${enc(id)}/move`, send('POST', { agentId }, true)),
      ),
    onSuccess: (moved, vars) => refresh(moved.job.agentId, vars.from),
  })
  const run = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`routines/${enc(id)}/run`, send('POST', undefined, true))
    },
    onSuccess: () => refresh(),
  })
  const runRecipe = useMutation({
    mutationFn: async (workflowId: string) =>
      RecipeScheduleSchema.parse(
        await apiFetch(`workflows/${enc(workflowId)}/schedule/run`, send('POST', {}, true)),
      ),
    onSuccess: () => refresh(),
  })
  const remove = useMutation({
    mutationFn: async ({ id }: { id: string; agentId: string }) => {
      await apiFetch(`routines/${enc(id)}`, send('DELETE', undefined, true))
    },
    onSuccess: (_none, vars) => refresh(vars.agentId),
  })
  return { create, patch, move, run, runRecipe, remove }
}

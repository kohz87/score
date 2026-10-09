import {
  ModelSettingsSchema,
  ModelVisibilitySchema,
  type ModelRef,
  type ModelSettingsUpdate,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

const settingsKey = (agentId: string) => ['team', 'model-settings', agentId] as const
const path = (agentId: string) => `agents/${encodeURIComponent(agentId)}/model-settings`

export function useModelSettings(agentId: string) {
  return useQuery({
    queryKey: settingsKey(agentId),
    queryFn: async ({ signal }) =>
      ModelSettingsSchema.parse(await apiFetch(path(agentId), { signal })),
    retry: false,
  })
}

/** Saves only what the caller sends; the answer is what Hermes now holds, so it replaces the cache at once. */
export function useUpdateModelSettings(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (update: ModelSettingsUpdate) =>
      ModelSettingsSchema.parse(
        await apiFetch(path(agentId), {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(update),
        }),
      ),
    onSuccess: async (settings) => {
      queryClient.setQueryData(settingsKey(agentId), settings)
      // The agent card's "falls back to" line and the pickers' alias rows follow the new settings.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['team', 'detail', agentId], exact: true }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ])
    },
  })
}

const visibilityKey = ['settings', 'model-visibility'] as const
export function useModelVisibility() {
  return useQuery({
    queryKey: visibilityKey,
    queryFn: async ({ signal }) =>
      ModelVisibilitySchema.parse(await apiFetch('settings/model-visibility', { signal })).items,
    retry: false,
  })
}
export function useSaveModelVisibility() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (items: ModelRef[]) =>
      ModelVisibilitySchema.parse(
        await apiFetch('settings/model-visibility', {
          method: 'PUT',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ items }),
        }),
      ).items,
    onSuccess: async (items) => {
      queryClient.setQueryData(visibilityKey, items)
      await queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })
}

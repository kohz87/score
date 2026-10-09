import {
  ContinueSessionResponseSchema,
  ImportSessionResponseSchema,
  OutsideSessionsResponseSchema,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

const key = ['outside-sessions'] as const

// Read from the agents' Hermes databases on request, so it is not in the stream: re-read on demand.
export function useOutsideSessions(enabled = true) {
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: async ({ signal }) =>
      OutsideSessionsResponseSchema.parse(await apiFetch('outside-sessions', { signal })),
    staleTime: 30_000,
    retry: false,
  })
}

export function useImportSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: { agentId: string; sessionId: string }) =>
      ImportSessionResponseSchema.parse(
        await apiFetch('outside-sessions/import', { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })
}

export function useContinueSession(roomId: string) {
  return useMutation({
    mutationFn: async () =>
      ContinueSessionResponseSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/continue-session`, {
          method: 'POST',
          body: '{}',
        }),
      ),
  })
}

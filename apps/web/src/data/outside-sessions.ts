import { OutsideSessionsResponseSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
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

import { AttemptDetailSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

export const attemptKey = (attemptId: string) => ['attempts', attemptId] as const

/** One attempt (`GET /api/attempts/:id`). A frozen record: it changes only while the attempt is still being observed. */
export function useAttempt(attemptId: string) {
  return useQuery({
    queryKey: attemptKey(attemptId),
    queryFn: async ({ signal }) =>
      AttemptDetailSchema.parse(
        await apiFetch(`attempts/${encodeURIComponent(attemptId)}`, { signal }),
      ),
    retry: false,
  })
}

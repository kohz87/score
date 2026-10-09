import { MessageSearchResponseSchema } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiFetch } from './api.ts'

/** Waits for typing to pause before it is used, so the server is asked once per word rather than per key. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** `GET /api/search/messages` (contract §5): needs at least two characters. */
export function useMessageSearch(text: string, limit = 20) {
  const q = useDebounced(text.trim())
  return useQuery({
    queryKey: ['search', 'messages', q, limit],
    enabled: q.length >= 2,
    queryFn: async ({ signal }) =>
      MessageSearchResponseSchema.parse(
        await apiFetch(`search/messages?${new URLSearchParams({ q, limit: String(limit) })}`, {
          signal,
        }),
      ).items,
    staleTime: 10_000,
    retry: false,
  })
}

export function messageHref(roomId: string, messageId: string): string {
  return `/chat/${encodeURIComponent(roomId)}?message=${encodeURIComponent(messageId)}`
}

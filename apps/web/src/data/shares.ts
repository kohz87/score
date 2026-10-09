import { ShareCreatedSchema, SharesResponseSchema } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

const allKey = ['shares', 'all'] as const
const roomKey = (roomId: string) => ['shares', 'room', roomId] as const

// Not in the stream: the lists are re-read after every change here.
export function useAllShares() {
  return useQuery({
    queryKey: allKey,
    queryFn: async () => SharesResponseSchema.parse(await apiFetch('shares')).items,
  })
}
export function useRoomShares(roomId: string) {
  return useQuery({
    queryKey: roomKey(roomId),
    queryFn: async () =>
      SharesResponseSchema.parse(await apiFetch(`rooms/${encodeURIComponent(roomId)}/shares`))
        .items,
  })
}
export function useCreateShare(roomId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: { password: string; expiresInDays: number; includeImages: boolean }) =>
      ShareCreatedSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/shares`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares'] }),
  })
}
export function useRevokeShare() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares'] }),
  })
}

export function shareFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'wrong_password') return 'That is not the security password.'
  if (code === 'too_many_attempts')
    return 'Too many wrong passwords. Wait 15 minutes and try again.'
  if (code === 'password_not_set')
    return 'Set a security password first (Settings › Remote access).'
  return 'Could not create the link. Please try again.'
}

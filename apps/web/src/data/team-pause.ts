import { NowSnapshotSchema, type StreamEvent } from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from './api.ts'
import { newId } from './ids.ts'
import { useStream } from './query-client.ts'

export const nowKey = ['now', 'score'] as const
const REFRESH_MS = 30_000
// At 1,000 events a minute a shorter wait refetches the whole snapshot several times a second (load test, task 5.3).
const THROTTLE_MS = 1000
// The Now snapshot is a read model the server recomputes, so these events only say "read it again".
const REFRESH_ON =
  /^(run|approval|message|brief|attempt)\.|^(task\.upserted|lane\.upserted|handoff\.created)$/

export function useNow() {
  const queryClient = useQueryClient()
  const stream = useStream()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void queryClient.invalidateQueries({ queryKey: nowKey })
      }, THROTTLE_MS)
    }
    const offEvents = stream.subscribe((event: StreamEvent) => {
      if (REFRESH_ON.test(event.type)) refresh()
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) refresh()
    })
    return () => {
      offEvents()
      offControl()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [stream, queryClient])
  return useQuery({
    queryKey: nowKey,
    queryFn: async ({ signal }) => NowSnapshotSchema.parse(await apiFetch('now', { signal })),
    // Moves the now line even when nothing happens.
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

function parseTeamPause(value: unknown): { paused: boolean; affectedRuns: number } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'paused' in value &&
    typeof value.paused === 'boolean' &&
    'affectedRuns' in value &&
    typeof value.affectedRuns === 'number'
  )
    return { paused: value.paused, affectedRuns: value.affectedRuns }
  throw new TypeError('Unexpected pause response')
}

export function useTeamPause() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ paused }: { paused: boolean }) =>
      parseTeamPause(
        await apiFetch(paused ? 'team/pause' : 'team/resume', {
          method: 'POST',
          headers: {
            'Idempotency-Key': newId(),
          },
          body: '{}',
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: nowKey }),
  })
}

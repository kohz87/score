import {
  HermesUpdateCheckSchema,
  HermesUpdateJobSchema,
  HermesUpdateStatusSchema,
  type HermesUpdateChannel,
  type HermesUpdateStatus,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'

// 3.15.0 (owner): Settings › System updates Hermes. The job lives in the server's memory, so the page polls it.
export const hermesUpdateKey = ['system', 'hermes-update'] as const
export const POLL_MS = 2_000

const CHANNEL_KEY = 'score.hermesUpdateChannel'

/** The channel remembered in this browser; `main` until the person picks (owner's default). */
export function readChannel(): HermesUpdateChannel {
  try {
    const stored = localStorage.getItem(CHANNEL_KEY)
    if (stored === 'stable' || stored === 'main') return stored
  } catch {
    // Storage can be blocked; the default is fine.
  }
  return 'main'
}

export function rememberChannel(channel: HermesUpdateChannel) {
  try {
    localStorage.setItem(CHANNEL_KEY, channel)
  } catch {
    // Not remembered; the choice still applies on this page.
  }
}

const post = (path: string, body: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify(body),
  })

/** While a job runs the status refetches every 2 s; it stops by itself when the job finishes or the page is left. */
export function useHermesUpdateStatus() {
  return useQuery({
    queryKey: hermesUpdateKey,
    queryFn: async ({ signal }) =>
      HermesUpdateStatusSchema.parse(await apiFetch('system/hermes-update', { signal })),
    retry: false,
    refetchInterval: (query) => (query.state.data?.job?.state === 'running' ? POLL_MS : false),
  })
}

export function useHermesUpdateActions() {
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: async (channel: HermesUpdateChannel) =>
      HermesUpdateCheckSchema.parse(await post('system/hermes-update/check', { channel })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hermesUpdateKey }),
  })
  const start = useMutation({
    mutationFn: async (body: {
      channel: HermesUpdateChannel
      testAgentId: string | null
      password: string
    }) => HermesUpdateJobSchema.parse(await post('system/hermes-update/start', body)),
    onSuccess: (job) => {
      // Show the running job at once instead of waiting for the first poll.
      queryClient.setQueryData<HermesUpdateStatus>(hermesUpdateKey, (old) =>
        old ? { ...old, job } : old,
      )
      void queryClient.invalidateQueries({ queryKey: hermesUpdateKey })
    },
  })
  return { check, start }
}

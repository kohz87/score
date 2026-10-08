import {
  ConfigApplyResponseSchema,
  ConfigPreviewResponseSchema,
  ConfigSearchResponseSchema,
  ConnectResultSchema,
  ConnectionsResponseSchema,
  HermesAcceptResponseSchema,
  HermesCheckSchema,
  ProviderItemSchema,
  ProvidersResponseSchema,
  SystemStatusSchema,
  type ConfigApplyRequest,
  type ConfigChange,
  type LocalProviderRequest,
  type SystemStatus,
  type ToolServerRequest,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

// Status only; the server never sends secrets. Not in the stream, so mutations invalidate these reads.
// Sign-ins and connections finish in a terminal outside Score, so these also re-check on focus, while a
// command is open (`watching`), and when the person presses Done.
const providersKey = ['settings', 'providers'] as const
const connectionsKey = ['settings', 'connections'] as const
const post = (path: string, body?: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const WATCH_MS = 5_000

export function useProviders(watching = false) {
  return useQuery({
    queryKey: providersKey,
    queryFn: async ({ signal }) =>
      ProvidersResponseSchema.parse(await apiFetch('settings/providers', { signal })).items,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: watching ? WATCH_MS : false,
    // The sign-in happens in another window, so keep checking while this tab is in the background.
    refetchIntervalInBackground: watching,
  })
}
export function useConnections(watching = false) {
  return useQuery({
    queryKey: connectionsKey,
    queryFn: async ({ signal }) =>
      ConnectionsResponseSchema.parse(await apiFetch('settings/connections', { signal })),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: watching ? WATCH_MS : false,
    // The sign-in happens in another window, so keep checking while this tab is in the background.
    refetchIntervalInBackground: watching,
  })
}
export function useRecheckSettings() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: providersKey })
    void queryClient.invalidateQueries({ queryKey: connectionsKey })
  }
}
export function useSettingsActions() {
  const queryClient = useQueryClient()
  const connectProvider = useMutation({
    mutationFn: async (id: string) =>
      ConnectResultSchema.parse(await post(`settings/providers/${encodeURIComponent(id)}/connect`)),
  })
  const addLocal = useMutation({
    mutationFn: async (req: LocalProviderRequest) =>
      ProviderItemSchema.parse(await post('settings/providers/local', req)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providersKey }),
  })
  const addToolServer = useMutation({
    mutationFn: async (req: ToolServerRequest) =>
      ConnectResultSchema.parse(await post('settings/tool-servers', req)),
  })
  const connectMessaging = useMutation({
    mutationFn: async (platform: string) =>
      ConnectResultSchema.parse(
        await post(`settings/messaging/${encodeURIComponent(platform)}/connect`),
      ),
  })
  return { connectProvider, addLocal, addToolServer, connectMessaging }
}

// Advanced config. Search results come from the server, which leaves out every credential-shaped key.
export function useConfigSearch(q: string) {
  return useQuery({
    queryKey: ['settings', 'config', q],
    queryFn: async ({ signal }) =>
      ConfigSearchResponseSchema.parse(
        await apiFetch(`settings/config?q=${encodeURIComponent(q)}`, { signal }),
      ).items,
    retry: false,
    placeholderData: (previous) => previous,
  })
}
export function useConfigActions() {
  const queryClient = useQueryClient()
  const preview = useMutation({
    mutationFn: async (changes: ConfigChange[]) =>
      ConfigPreviewResponseSchema.parse(await post('settings/config/preview', { changes })),
  })
  const apply = useMutation({
    mutationFn: async (req: ConfigApplyRequest) =>
      ConfigApplyResponseSchema.parse(await post('settings/config/apply', req)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'config'] }),
  })
  return { preview, apply }
}

// Not in the stream as a query: the Settings banner and the nav dot poll it, and an accept refetches it.
export const systemKey = ['system'] as const
export function useSystemStatus() {
  return useQuery({
    queryKey: systemKey,
    queryFn: async ({ signal }) => SystemStatusSchema.parse(await apiFetch('system', { signal })),
    refetchInterval: 60_000,
    retry: false,
  })
}
/** True when the compatibility gate paused approvals because the Hermes build is not one Score has checked. */
export function needsHermesCheck(status: SystemStatus | undefined): boolean {
  return Boolean(
    status &&
    !status.compatibility.tested &&
    status.compatibility.disabled.includes('gateway-approvals'),
  )
}
export function useHermesCheck() {
  const queryClient = useQueryClient()
  const check = useMutation({
    mutationFn: async () => HermesCheckSchema.parse(await post('settings/hermes/check')),
  })
  const accept = useMutation({
    mutationFn: async (hash: string) =>
      HermesAcceptResponseSchema.parse(await post('settings/hermes/accept', { hash })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: systemKey }),
  })
  return { check, accept }
}

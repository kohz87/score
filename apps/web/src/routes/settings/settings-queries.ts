import {
  ConfigApplyResponseSchema,
  ConfigPreviewResponseSchema,
  ConfigSearchResponseSchema,
  ConnectResultSchema,
  ConnectionsResponseSchema,
  ProviderItemSchema,
  ProvidersResponseSchema,
  SignInSchema,
  type ConfigApplyRequest,
  type ConfigChange,
  type ProviderItem,
  type LocalProviderRequest,
  type ProviderKeyRequest,
  type SignIn,
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

// Sign-in from the browser (ARCHITECTURE D2.7). The server keeps device sign-ins in memory; the page follows one until
// it ends. Background tabs keep polling, because the approval happens in another window.
const SIGN_IN_POLL_MS = 2_000
export function useSignIn(id: string) {
  return useQuery({
    queryKey: ['settings', 'sign-in', id],
    queryFn: async ({ signal }) =>
      SignInSchema.parse(await apiFetch(`settings/sign-ins/${encodeURIComponent(id)}`, { signal })),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && query.state.data.state !== 'waiting' ? false : SIGN_IN_POLL_MS,
    refetchIntervalInBackground: true,
  })
}
export async function cancelSignIn(id: string): Promise<SignIn> {
  return SignInSchema.parse(
    await apiFetch(`settings/sign-ins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  )
}
/**
 * Sends a pasted key. Deliberately not a query-client mutation: those keep their variables in a cache, and the key
 * must exist only in this call and the form's own state.
 */
export async function sendProviderKey(id: string, req: ProviderKeyRequest): Promise<ProviderItem> {
  return ProviderItemSchema.parse(
    await post(`settings/providers/${encodeURIComponent(id)}/key`, req),
  )
}

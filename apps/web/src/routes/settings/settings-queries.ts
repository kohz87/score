import {
  ConnectResultSchema,
  ConnectionsResponseSchema,
  ProviderItemSchema,
  ProvidersResponseSchema,
  type LocalProviderRequest,
  type ToolServerRequest,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

// Status only; the server never sends secrets. Not in the stream, so mutations invalidate these reads.
const providersKey = ['settings', 'providers'] as const
const connectionsKey = ['settings', 'connections'] as const
const post = (path: string, body?: unknown) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

export function useProviders() {
  return useQuery({
    queryKey: providersKey,
    queryFn: async ({ signal }) =>
      ProvidersResponseSchema.parse(await apiFetch('settings/providers', { signal })).items,
    retry: false,
  })
}
export function useConnections() {
  return useQuery({
    queryKey: connectionsKey,
    queryFn: async ({ signal }) =>
      ConnectionsResponseSchema.parse(await apiFetch('settings/connections', { signal })),
    retry: false,
  })
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

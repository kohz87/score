import {
  ConfigApplyResponseSchema,
  ConfigPreviewResponseSchema,
  ConfigSearchResponseSchema,
  ConnectResultSchema,
  ConnectionsResponseSchema,
  PluginItemSchema,
  PluginsResponseSchema,
  ProviderItemSchema,
  ProvidersResponseSchema,
  type ConfigApplyRequest,
  type ConfigChange,
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

// Plugins are per profile and not in the stream; a toggle replaces the row from the verified response.
export const pluginsKey = (agentId: string) => ['settings', 'plugins', agentId] as const
export function usePlugins(agentId: string | undefined) {
  return useQuery({
    queryKey: pluginsKey(agentId ?? ''),
    enabled: Boolean(agentId),
    queryFn: async ({ signal }) =>
      PluginsResponseSchema.parse(
        await apiFetch(`settings/plugins?agent=${encodeURIComponent(agentId!)}`, { signal }),
      ).items,
    retry: false,
  })
}
export function usePluginToggle(agentId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      PluginItemSchema.parse(
        await apiFetch(
          `settings/plugins/${encodeURIComponent(id)}?agent=${encodeURIComponent(agentId)}`,
          {
            method: 'PATCH',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({ enabled }),
          },
        ),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: pluginsKey(agentId) }),
  })
}

import {
  McpAccessSchema,
  McpTokenIssuedSchema,
  type McpAccess,
  type McpAccessPatch,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

const key = (agentId: string) => ['team', 'mcp-access', agentId] as const
const path = (agentId: string) => `agents/${encodeURIComponent(agentId)}/mcp`

export function useMcpAccess(agentId: string) {
  return useQuery({
    queryKey: key(agentId),
    queryFn: async ({ signal }) => McpAccessSchema.parse(await apiFetch(path(agentId), { signal })),
    retry: false,
  })
}

export function useChangeMcpAccess(agentId: string) {
  const queryClient = useQueryClient()
  const store = (data: McpAccess) => queryClient.setQueryData(key(agentId), data)
  return {
    patch: useMutation({
      mutationFn: async (change: McpAccessPatch) =>
        McpAccessSchema.parse(
          await apiFetch(path(agentId), { method: 'PUT', body: JSON.stringify(change) }),
        ),
      onSuccess: store,
    }),
    // The token is in this response only: the caller shows it once and drops it.
    issue: useMutation({
      mutationFn: async () =>
        McpTokenIssuedSchema.parse(await apiFetch(`${path(agentId)}/token`, { method: 'POST' })),
      onSuccess: (issued) => store(issued.access),
    }),
    revoke: useMutation({
      mutationFn: async () =>
        McpAccessSchema.parse(await apiFetch(`${path(agentId)}/token`, { method: 'DELETE' })),
      onSuccess: store,
    }),
  }
}

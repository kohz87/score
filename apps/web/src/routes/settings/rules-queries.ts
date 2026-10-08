import {
  AgentDetailSchema,
  AgentPermissionsResponseSchema,
  PatchPermissionRequestSchema,
  RulesPreviewResponseSchema,
  RulesResponseSchema,
  RulesWriteResponseSchema,
  type PutRulesRequest,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

const rulesKey = ['settings', 'rules'] as const
const send = (path: string, method: 'PUT' | 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  apiFetch(path, {
    method,
    headers: { 'Idempotency-Key': newId() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

export function useRules() {
  return useQuery({
    queryKey: rulesKey,
    queryFn: async ({ signal }) =>
      RulesResponseSchema.parse(await apiFetch('settings/rules', { signal })),
    retry: false,
  })
}

/** Rules change agents' permissions too: refresh every cached agent detail. */
function useRefreshRules() {
  const queryClient = useQueryClient()
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: rulesKey }),
      queryClient.invalidateQueries({ queryKey: ['team', 'detail'] }),
    ])
  }
}

export function useRulesActions() {
  const refresh = useRefreshRules()
  const preview = useMutation({
    mutationFn: async (req: PutRulesRequest) =>
      RulesPreviewResponseSchema.parse(await send('settings/rules?dryRun=1', 'PUT', req)).preview,
  })
  const save = useMutation({
    mutationFn: async (req: PutRulesRequest) =>
      RulesWriteResponseSchema.parse(await send('settings/rules', 'PUT', req)),
    onSuccess: refresh,
  })
  const apply = useMutation({
    mutationFn: async (agentId: string) =>
      RulesResponseSchema.parse(
        await send(`settings/rules/apply/${encodeURIComponent(agentId)}`, 'POST'),
      ),
    onSuccess: refresh,
  })
  return { preview, save, apply }
}

const PermissionRowSchema = AgentDetailSchema.shape.permissions.element
export function usePermissionAction(agentId: string) {
  const refresh = useRefreshRules()
  return useMutation({
    mutationFn: async ({ id, level }: { id: string; level: 'allowed' | 'asks' | 'never' }) =>
      PermissionRowSchema.parse(
        await send(
          `agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(id)}`,
          'PATCH',
          PatchPermissionRequestSchema.parse({ level }),
        ),
      ),
    onSuccess: refresh,
  })
}

/** Takes back this agent's own choice so it follows the team rule again. */
export function useUseTeamRule(agentId: string) {
  const refresh = useRefreshRules()
  return useMutation({
    mutationFn: async (id: string) =>
      AgentPermissionsResponseSchema.parse(
        await send(
          `agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(id)}`,
          'DELETE',
        ),
      ).items,
    onSuccess: refresh,
  })
}

import {
  RoomSchema,
  SharedWorkspaceListSchema,
  SharedWorkspaceSchema,
  type Room,
  type SharedWorkspace,
  type SharedWorkspaceCreateRequest,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { newId } from '../data/ids.ts'

export const workspacesKey = ['settings', 'workspaces'] as const

export function useSharedWorkspaces(enabled = true) {
  return useQuery({
    queryKey: workspacesKey,
    queryFn: async ({ signal }) =>
      SharedWorkspaceListSchema.parse(await apiFetch('workspaces', { signal })).workspaces,
    enabled,
    retry: false,
  })
}

const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'Idempotency-Key': newId() },
})

export async function createSharedWorkspace(
  request: SharedWorkspaceCreateRequest,
): Promise<SharedWorkspace> {
  return SharedWorkspaceSchema.parse(
    await apiFetch('workspaces', { method: 'POST', ...json(request) }),
  )
}

export async function updateSharedWorkspace(
  id: string,
  request: { name?: string; agentIds?: string[] },
): Promise<SharedWorkspace> {
  return SharedWorkspaceSchema.parse(
    await apiFetch(`workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', ...json(request) }),
  )
}

export async function deleteSharedWorkspace(id: string): Promise<void> {
  await apiFetch(`workspaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': newId() },
  })
}

export async function setAgentFolder(id: string, agentId: string): Promise<void> {
  await apiFetch(`workspaces/${encodeURIComponent(id)}/use-as-folder`, {
    method: 'POST',
    ...json({ agentId }),
  })
}

/** The room's workspace (null = none). The room itself arrives on the stream as room.upserted. */
export async function setRoomWorkspace(roomId: string, workspaceId: string | null): Promise<Room> {
  return RoomSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(roomId)}/workspace`, {
      method: 'PUT',
      ...json({ workspaceId }),
    }),
  )
}

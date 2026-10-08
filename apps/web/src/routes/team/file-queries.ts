import { useQuery } from '@tanstack/react-query'
import {
  AgentFileConflictSchema,
  AgentFilePreviewSchema,
  AgentFileSchema,
  AgentFileWriteSchema,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'

export type AgentFileName = 'SOUL.md' | 'AGENTS.md'
export const parseAgentFile = (value: unknown) => AgentFileSchema.parse(value)
export const parseDiff = (value: unknown) => AgentFilePreviewSchema.parse(value).diff
export const parseEtag = (value: unknown) => AgentFileWriteSchema.parse(value).etag
export function parseConflict(value: unknown): { etag: string; diff: string } | null {
  const conflict = AgentFileConflictSchema.safeParse(value)
  return conflict.success ? conflict.data : null
}

export const fileKey = (agentId: string, file: AgentFileName) =>
  ['team', 'file', agentId, file] as const
export const filePath = (agentId: string, file: AgentFileName) =>
  `agents/${encodeURIComponent(agentId)}/files/${file}`

export function useAgentFile(agentId: string, file: AgentFileName) {
  return useQuery({
    queryKey: fileKey(agentId, file),
    queryFn: async ({ signal }) =>
      parseAgentFile(await apiFetch(filePath(agentId, file), { signal })),
    // The etag is the edit's base: it must never change under an unsaved draft, so reloads are explicit.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

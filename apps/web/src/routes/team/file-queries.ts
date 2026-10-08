import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

// The contract package has no schemas for these endpoints yet (API-CONTRACT §8) and the web app has no
// zod of its own, so responses are checked by hand until the contract exports them.
export type AgentFileName = 'SOUL.md' | 'AGENTS.md'
type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: Dict, key: string): string => {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`Malformed response: ${key}`)
  return field
}
export function parseAgentFile(value: unknown): { content: string; etag: string } {
  if (!isDict(value)) throw new Error('Malformed response')
  return { content: text(value, 'content'), etag: text(value, 'etag') }
}
export const parseDiff = (value: unknown): string => {
  if (!isDict(value)) throw new Error('Malformed response')
  return text(value, 'diff')
}
export const parseEtag = (value: unknown): string => {
  if (!isDict(value)) throw new Error('Malformed response')
  return text(value, 'etag')
}
export function parseConflict(value: unknown): { etag: string; diff: string } | null {
  try {
    return isDict(value) ? { etag: text(value, 'etag'), diff: text(value, 'diff') } : null
  } catch {
    return null
  }
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

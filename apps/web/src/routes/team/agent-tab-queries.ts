import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'

// The contract (§8) names these routes but has no response schemas for them yet, so the shared
// AgentDetail pieces validate what they can and the hub rows get a small local guard.
export type Skill = AgentDetail['skills'][number]
export type MemoryEntry = AgentDetail['memory'][number]
export type Tool = AgentDetail['tools'][number]
export interface HubSkill {
  name: string
  identifier: string
  source: string
  trust: string
  description: string
}
export interface MemoryPageData {
  items: MemoryEntry[]
  nextCursor: string | null
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const parseSkills = (body: unknown): Skill[] =>
  AgentDetailSchema.shape.skills.parse(record(body).items)
export const parseTool = (body: unknown): Tool => AgentDetailSchema.shape.tools.element.parse(body)
export function parseHub(body: unknown): HubSkill[] {
  const items = record(body).items
  if (!Array.isArray(items)) throw new Error('Unexpected skills hub response')
  return items.map((row) => {
    const item = record(row)
    if (!text(item.identifier)) throw new Error('Unexpected skills hub response')
    return {
      name: text(item.name) || text(item.identifier),
      identifier: text(item.identifier),
      source: text(item.source),
      trust: text(item.trust),
      description: text(item.description),
    }
  })
}
export function parseMemoryPage(body: unknown): MemoryPageData {
  const page = record(body)
  const next = page.nextCursor
  if (next !== null && typeof next !== 'string') throw new Error('Unexpected memory response')
  return { items: AgentDetailSchema.shape.memory.parse(page.items), nextCursor: next }
}

const agentPath = (agentId: string) => `agents/${encodeURIComponent(agentId)}`
const detailKey = (agentId: string) => ['team', 'detail', agentId] as const
const skillsKey = (agentId: string) => ['team', 'skills', agentId] as const
const memoryKey = (agentId: string, q: string) => ['team', 'memory', agentId, q] as const
const mutationHeaders = (key: string = crypto.randomUUID()) => ({ 'Idempotency-Key': key })

/** Changes made here also change the agent detail the Overview and the other tabs read. */
function useRefresh(agentId: string) {
  const queryClient = useQueryClient()
  return async (...extra: (readonly unknown[])[]) => {
    await Promise.all(
      [detailKey(agentId), ...extra].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey, exact: true }),
      ),
    )
  }
}

export function useModelAction(agentId: string) {
  const refresh = useRefresh(agentId)
  return useMutation({
    mutationFn: async (req: { model: string; provider?: string }) =>
      AgentDetailSchema.parse(
        await apiFetch(`${agentPath(agentId)}/model`, {
          method: 'PUT',
          headers: mutationHeaders(),
          body: JSON.stringify(req),
        }),
      ),
    onSuccess: () => refresh(),
  })
}

export function useSkills(agentId: string) {
  return useQuery({
    queryKey: skillsKey(agentId),
    queryFn: async ({ signal }) =>
      parseSkills(await apiFetch(`${agentPath(agentId)}/skills`, { signal })),
    retry: false,
  })
}
export function useHubSearch(query: string) {
  return useQuery({
    queryKey: ['team', 'skills-hub', query],
    queryFn: async ({ signal }) =>
      parseHub(await apiFetch(`skills/hub?q=${encodeURIComponent(query)}`, { signal })),
    enabled: query.trim().length > 0,
    retry: false,
    staleTime: 60_000,
  })
}
export function useSkillActions(agentId: string) {
  const refresh = useRefresh(agentId)
  const toggle = useMutation({
    mutationFn: async ({ name, enabled }: { name: string; enabled: boolean }) =>
      apiFetch(`${agentPath(agentId)}/skills/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: mutationHeaders(),
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => refresh(skillsKey(agentId)),
  })
  const install = useMutation({
    mutationFn: async (identifier: string) =>
      parseSkills(
        await apiFetch(`${agentPath(agentId)}/skills`, {
          method: 'POST',
          headers: mutationHeaders(),
          body: JSON.stringify({ name: identifier }),
        }),
      ),
    onSuccess: () => refresh(skillsKey(agentId)),
  })
  return { toggle, install }
}

export function useMemory(agentId: string, q: string) {
  return useInfiniteQuery({
    queryKey: memoryKey(agentId, q),
    initialPageParam: '',
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (pageParam) params.set('cursor', pageParam)
      const query = params.toString()
      return parseMemoryPage(
        await apiFetch(`${agentPath(agentId)}/memory${query ? `?${query}` : ''}`, { signal }),
      )
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}
export function useMemoryActions(agentId: string) {
  const queryClient = useQueryClient()
  const refresh = useRefresh(agentId)
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['team', 'memory', agentId] })
    await refresh()
  }
  const add = useMutation({
    mutationFn: async ({ text, key }: { text: string; key: string }) =>
      AgentDetailSchema.shape.memory.element.parse(
        await apiFetch(`${agentPath(agentId)}/memory`, {
          method: 'POST',
          headers: mutationHeaders(key),
          body: JSON.stringify({ text }),
        }),
      ),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`${agentPath(agentId)}/memory/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: mutationHeaders(),
      })
    },
    onSuccess: done,
  })
  return { add, remove }
}

export function useToolAction(agentId: string) {
  const refresh = useRefresh(agentId)
  return useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      parseTool(
        await apiFetch(`${agentPath(agentId)}/tools/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: mutationHeaders(),
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: () => refresh(),
  })
}

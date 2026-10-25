import {
  CommandsResponseSchema,
  DirectChatsResponseSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  MessageSearchResponseSchema,
  NowSnapshotSchema,
  type AgentSummary,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { apiFetch } from '../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../data/query-client.ts'
import { useDebounced } from '../data/message-search.ts'
import { nowKey } from '../data/team-pause.ts'
import type { BoldSearchCommand, BoldSearchNote } from './bold-search-model.ts'
import { teamRoomQuery } from './room/room-queries.ts'

/** The team room and its jobs. `fresh`: read again whenever the caller mounts (Search opens), so a job made moments
 * ago is found even though the first-run routing (BoldHome) read the same key when /b opened. */
export function useBoldTeamRoom({ fresh = false }: { fresh?: boolean } = {}) {
  const definition = useMemo(() => teamRoomQuery(null), [])
  const state = useStreamQuery(definition)
  const refetch = useStreamQueryRefetch(definition)
  useEffect(() => {
    if (fresh) void refetch()
  }, [fresh, refetch])
  return {
    data: state.data,
    // A refetch behind a usable snapshot is not a cold read: `/b` keeps showing the room while it refreshes.
    isPending: state.data === undefined && state.status === 'pending',
    isError: state.status === 'error',
    refetch,
  }
}

/** Every agent's one-to-one chats; one failing agent must not blank the other agents' results. */
export function useBoldDirectChats(agents: readonly AgentSummary[]) {
  const ids = agents.map((agent) => agent.id)
  return useQuery({
    queryKey: ['bold-search', 'directs', ...ids],
    enabled: ids.length > 0,
    queryFn: async ({ signal }) => {
      const answers = await Promise.allSettled(
        ids.map(async (agentId) => {
          const data = DirectChatsResponseSchema.parse(
            await apiFetch(`agents/${encodeURIComponent(agentId)}/direct`, { signal }),
          )
          return { agentId, chats: data.chats }
        }),
      )
      return answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []))
    },
    staleTime: 5_000,
    retry: false,
  })
}

const notesFromTree = (notes: BoldSearchNote[]): BoldSearchNote[] =>
  notes.map(({ path, title, lastAuthor }) => ({ path, title, lastAuthor }))

/** The Library's first page while the box is empty, then FTS results once there is a query. */
export function useBoldNotes(query: string) {
  const q = useDebounced(query.trim(), 180)
  const tree = useQuery({
    queryKey: ['bold-search', 'knowledge-tree'],
    enabled: q === '',
    queryFn: async ({ signal }) => {
      const data = KnowledgeTreeSchema.parse(await apiFetch('knowledge/tree', { signal }))
      return notesFromTree(data.notes).slice(0, 20)
    },
    staleTime: 5_000,
    retry: false,
  })
  const search = useQuery({
    queryKey: ['bold-search', 'knowledge-search', q],
    enabled: q !== '' && !q.startsWith('/') && !q.startsWith('@'),
    queryFn: async ({ signal }) => {
      const data = KnowledgeSearchResponseSchema.parse(
        await apiFetch(`knowledge/search?${new URLSearchParams({ q, limit: '20' })}`, { signal }),
      )
      return data.items
        .filter((hit) => hit.kind === 'note')
        .map<BoldSearchNote>(({ path, title, snippet }) => ({ path, title, snippet }))
    },
    placeholderData: (previous) => previous,
    staleTime: 5_000,
    retry: false,
  })
  return q === '' ? tree : search
}

/** Contract §5 search; the bold shell searches every job, unlike the classic palette's `jobs=default`. */
export function useBoldMessageSearch(text: string, limit = 4) {
  const q = useDebounced(text.trim(), 220)
  return useQuery({
    queryKey: ['bold-search', 'messages', q, limit],
    enabled: q.length >= 2 && !q.startsWith('/') && !q.startsWith('@'),
    queryFn: async ({ signal }) =>
      MessageSearchResponseSchema.parse(
        await apiFetch(`search/messages?${new URLSearchParams({ q, limit: String(limit) })}`, {
          signal,
        }),
      ).items,
    placeholderData: (previous) => previous,
    staleTime: 10_000,
    retry: false,
  })
}

export function useBoldCommands() {
  return useQuery({
    queryKey: ['bold-search', 'commands'],
    queryFn: async ({ signal }) =>
      CommandsResponseSchema.parse(await apiFetch('commands', { signal }))
        .items as BoldSearchCommand[],
    staleTime: Infinity,
    retry: false,
  })
}

/** Pause everyone changes the action's wording, so reuse Now's snapshot when the shell already has it. */
export function useBoldPaused() {
  const held = useQuery({
    queryKey: nowKey,
    queryFn: async ({ signal }) => NowSnapshotSchema.parse(await apiFetch('now', { signal })),
    enabled: false,
    retry: false,
  })
  const fallback = useQuery({
    queryKey: ['bold-search', 'paused'],
    enabled: held.data === undefined && !held.isFetching,
    queryFn: async ({ signal }) =>
      NowSnapshotSchema.parse(await apiFetch('now', { signal })).paused,
    staleTime: 5_000,
    retry: false,
  })
  return held.data !== undefined
    ? { data: held.data.paused, isError: false }
    : { data: fallback.data, isError: fallback.isError }
}

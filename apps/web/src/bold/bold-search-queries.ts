import {
  CommandsResponseSchema,
  DirectChatsResponseSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  MessageSearchResponseSchema,
  NowSnapshotSchema,
  TeamRoomResponseSchema,
  type AgentSummary,
  type Job,
  type Room,
} from '@score/contract'
import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apiFetch } from '../data/api.ts'
import { useDebounced } from '../data/message-search.ts'
import { useOptionalStream } from '../data/query-client.ts'
import { nowKey } from '../data/team-pause.ts'
import { fetchRoutines, routinesKey } from '../routes/team/routine-queries.ts'
import type { BoldSearchCommand, BoldSearchNote, BoldSearchRoutine } from './bold-search-model.ts'

const BOLD_SEARCH_TEAM_KEY = ['bold-search', 'team-room'] as const
const BOLD_SEARCH_DIRECTS_KEY = ['bold-search', 'directs'] as const

type SearchTeamRoom = { asOfSeq: number; room: Room; jobs: Job[] }
type SearchDirects = { agentId: string; chats: Job[] }[]

/** A job deleted in another tab or by the server must leave Search's own caches too, not only the stream reads. */
export function dropCachedJobFromSearch(
  queryClient: QueryClient,
  deleted: { id: string; roomId: string },
): void {
  queryClient.setQueryData<SearchTeamRoom>(BOLD_SEARCH_TEAM_KEY, (snapshot) =>
    snapshot && snapshot.room.id === deleted.roomId
      ? { ...snapshot, jobs: snapshot.jobs.filter((job) => job.id !== deleted.id) }
      : snapshot,
  )
  for (const query of queryClient.getQueryCache().findAll({ queryKey: BOLD_SEARCH_DIRECTS_KEY })) {
    queryClient.setQueryData<SearchDirects>(query.queryKey, (entries) =>
      entries?.map((entry) => ({
        ...entry,
        chats: entry.chats.filter((chat) => chat.id !== deleted.id),
      })),
    )
  }
}

function useBoldSearchJobDeletions(): void {
  const stream = useOptionalStream()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!stream) return
    return stream.subscribe((event) => {
      if (event.type === 'job.deleted') dropCachedJobFromSearch(queryClient, event.data)
    })
  }, [queryClient, stream])
}

/** The team room and its jobs. `fresh`: read again whenever the caller mounts (Search opens), so a job made moments
 * ago is found even though the first-run routing (BoldHome) read the same key when /b opened. */
export function useBoldTeamRoom({ fresh = false }: { fresh?: boolean } = {}) {
  useBoldSearchJobDeletions()
  return useQuery({
    queryKey: BOLD_SEARCH_TEAM_KEY,
    queryFn: async ({ signal }) =>
      TeamRoomResponseSchema.parse(await apiFetch('team-room', { signal })),
    staleTime: 5_000,
    ...(fresh ? { refetchOnMount: 'always' as const } : {}),
    retry: false,
  })
}

/** Every agent's one-to-one chats; one failing agent must not blank the other agents' results. */
export function useBoldDirectChats(agents: readonly AgentSummary[]) {
  const ids = agents.map((agent) => agent.id)
  useBoldSearchJobDeletions()
  return useQuery({
    queryKey: [...BOLD_SEARCH_DIRECTS_KEY, ...ids],
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

/** Every agent's routines; one failing agent must not blank the other agents' results. */
export function useBoldRoutines(agents: readonly AgentSummary[]): BoldSearchRoutine[] {
  const results = useQueries({
    queries: agents.map((agent) => ({
      queryKey: routinesKey(agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRoutines(agent.id, signal),
      staleTime: 5_000,
      retry: false,
    })),
  })
  return agents.flatMap((agent, index) => {
    const routines = results[index]?.data
    return routines ? routines.map((routine) => ({ ...routine, agentId: agent.id })) : []
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

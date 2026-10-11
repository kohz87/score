import {
  KnowledgeConflictSchema,
  KnowledgeHistorySchema,
  KnowledgeInfoSchema,
  KnowledgeMoveResponseSchema,
  KnowledgeNoteSchema,
  KnowledgeSearchResponseSchema,
  KnowledgeTreeSchema,
  KnowledgeVersionSchema,
  KnowledgeWriteResponseSchema,
  type KnowledgeChanged,
  type KnowledgeNote,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { useStream } from '../../data/query-client.ts'
import { documentApi, fetchDocument } from './knowledge-files.ts'
import { apiNote, notePath } from './knowledge-paths.ts'

export const knowledgeKey = ['knowledge'] as const
export const infoKey = [...knowledgeKey, 'info'] as const
export const treeKey = [...knowledgeKey, 'tree'] as const
export const noteKey = (path: string) => [...knowledgeKey, 'note', path] as const
export const historyKey = (path: string) => [...knowledgeKey, 'history', path] as const

export function useKnowledgeInfo() {
  return useQuery({
    queryKey: infoKey,
    queryFn: async ({ signal }) =>
      KnowledgeInfoSchema.parse(await apiFetch('knowledge', { signal })),
    retry: false,
  })
}

export function useKnowledgeTree() {
  return useQuery({
    queryKey: treeKey,
    queryFn: async ({ signal }) =>
      KnowledgeTreeSchema.parse(await apiFetch('knowledge/tree', { signal })),
    retry: false,
  })
}

export async function fetchNote(path: string, signal?: AbortSignal): Promise<KnowledgeNote> {
  return KnowledgeNoteSchema.parse(await apiFetch(apiNote(path), signal ? { signal } : {}))
}

/** The write behind autosave. A plain function (not a mutation hook) so a save outlives the editor that started it. */
export async function saveNote(req: { path: string; body: string; etag: string | null }) {
  return KnowledgeWriteResponseSchema.parse(
    await apiFetch(apiNote(req.path), {
      method: 'PUT',
      body: JSON.stringify({ body: req.body, etag: req.etag }),
    }),
  )
}

/** Text that could not be saved when its editor closed; the next editor for that note starts from it. */
export const orphanDrafts = new Map<string, { body: string; etag: string | null }>()

/** Thrown when an operation had to save the draft first and that failed. */
export class UnsavedDraftError extends Error {
  constructor() {
    super('The unsaved changes could not be saved')
  }
}

export function useNote(path: string | null) {
  return useQuery({
    queryKey: noteKey(path ?? ''),
    enabled: path !== null,
    queryFn: ({ signal }) => fetchNote(path!, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useDocument(path: string | null) {
  return useQuery({
    queryKey: [...knowledgeKey, 'document', path ?? ''],
    enabled: path !== null,
    queryFn: ({ signal }) => fetchDocument(path!, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function useHistory(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: historyKey(path ?? ''),
    enabled: path !== null && enabled,
    queryFn: async ({ signal }) =>
      KnowledgeHistorySchema.parse(await apiFetch(apiNote(path!, '/history'), { signal })).items,
    gcTime: 0,
    retry: false,
  })
}

export function useVersion(path: string, commit: string | null) {
  return useQuery({
    queryKey: [...historyKey(path), commit],
    enabled: commit !== null,
    queryFn: async ({ signal }) =>
      KnowledgeVersionSchema.parse(
        await apiFetch(apiNote(path, `/versions/${encodeURIComponent(commit!)}`), { signal }),
      ),
    retry: false,
  })
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: [...knowledgeKey, 'search', q],
    enabled: q !== '',
    queryFn: async ({ signal }) =>
      KnowledgeSearchResponseSchema.parse(
        await apiFetch(`knowledge/search?q=${encodeURIComponent(q)}&limit=20`, { signal }),
      ).items,
    staleTime: 0,
    retry: false,
  })
}

/** `details.etag` of a 412: the note's current etag, or null when it was removed. */
export function conflictOf(error: unknown): { etag: string | null } | null {
  if (!(error instanceof ApiError) || error.status !== 412) return null
  const parsed = KnowledgeConflictSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

export function knowledgeFailure(error: unknown, action: string): string {
  if (error instanceof UnsavedDraftError)
    return 'Your unsaved changes could not be saved first, so nothing was changed. Fix that and try again.'
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return `Pair this browser using the link in the server terminal to ${action}.`
    if (error.code === 'exists') return 'Something with that name already exists.'
    if (error.code === 'not_empty') return 'That folder is not empty.'
    if (error.code === 'unsupported_type' || error.code === 'export_too_large') return error.message
    if (error.code === 'bad_path' || error.code === 'not_a_note') return error.message
    if (error.code === 'payload_too_large')
      return 'That note is too large (8 MiB at most; one image 1.5 MB).'
    if (error.status === 404) return 'That note is no longer there.'
  }
  return `Could not ${action}. Please try again.`
}

export function useKnowledgeActions() {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: knowledgeKey })
  return {
    // A save does not refetch the open note: the editor keeps its text and the panels refetch on their own.
    save: useMutation({
      mutationFn: async (req: { path: string; body: string; etag: string | null }) =>
        KnowledgeWriteResponseSchema.parse(
          await apiFetch(apiNote(req.path), {
            method: 'PUT',
            body: JSON.stringify({ body: req.body, etag: req.etag }),
          }),
        ),
    }),
    move: useMutation({
      mutationFn: async (req: { from: string; to: string; updateLinks: boolean }) =>
        KnowledgeMoveResponseSchema.parse(
          await apiFetch('knowledge/move', { method: 'POST', body: JSON.stringify(req) }),
        ),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (path: string) => apiFetch(apiNote(path), { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    removeDocument: useMutation({
      mutationFn: (path: string) => apiFetch(documentApi(path), { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    createFolder: useMutation({
      mutationFn: (path: string) =>
        apiFetch('knowledge/folders', { method: 'POST', body: JSON.stringify({ path }) }),
      onSuccess: refresh,
    }),
    removeFolder: useMutation({
      mutationFn: (path: string) =>
        apiFetch(`knowledge/folders/${notePath(path)}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    restore: useMutation({
      mutationFn: async (req: { path: string; commit: string }) =>
        KnowledgeWriteResponseSchema.parse(
          await apiFetch(apiNote(req.path, '/restore'), {
            method: 'POST',
            body: JSON.stringify({ commit: req.commit }),
          }),
        ),
      onSuccess: refresh,
    }),
    setAgentAccess: useMutation({
      mutationFn: async (agentAccess: boolean) =>
        KnowledgeInfoSchema.parse(
          await apiFetch('knowledge/settings', {
            method: 'PUT',
            body: JSON.stringify({ agentAccess }),
          }),
        ),
      onSuccess: refresh,
    }),
  }
}

/** Every `knowledge.changed` refreshes the tree, search and info; the page also gets the event itself (to decide
 *  whether the open note changed under the editor). A stream resync refreshes everything. */
export function useKnowledgeLive(onChanged?: (event: KnowledgeChanged) => void) {
  const stream = useStream()
  const queryClient = useQueryClient()
  const handler = useRef(onChanged)
  useEffect(() => {
    handler.current = onChanged
  })
  useEffect(() => {
    const offEvent = stream.subscribe((event) => {
      if (event.type !== 'knowledge.changed') return
      void queryClient.invalidateQueries({ queryKey: treeKey })
      void queryClient.invalidateQueries({ queryKey: infoKey })
      void queryClient.invalidateQueries({ queryKey: [...knowledgeKey, 'search'] })
      // The open note's links and backlinks depend on the other notes; its editor text is not touched by this.
      void queryClient.invalidateQueries({ queryKey: [...knowledgeKey, 'note'] })
      void queryClient.invalidateQueries({ queryKey: [...knowledgeKey, 'document'] })
      handler.current?.(event.data)
    })
    const offControl = stream.onControl(({ resync }) => {
      if (resync) void queryClient.invalidateQueries({ queryKey: knowledgeKey })
    })
    return () => {
      offEvent()
      offControl()
    }
  }, [stream, queryClient])
}

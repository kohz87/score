import {
  WorkspaceBinarySchema,
  WorkspaceConflictSchema,
  WorkspaceGitSchema,
  WorkspaceInfoSchema,
  WorkspaceTreeSchema,
  WorkspaceWriteResponseSchema,
} from '@score/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'

const base = (agentId: string) => `agents/${encodeURIComponent(agentId)}/workspace`
const rootParam = (root: string | undefined) =>
  root === undefined ? '' : `&root=${encodeURIComponent(root)}`
const withPath = (agentId: string, tail: string, path: string, extra = '', root?: string) =>
  `${base(agentId)}/${tail}?path=${encodeURIComponent(path)}${extra}${rootParam(root)}`

/** The root the browser is showing: every file request names it, so a root changed elsewhere is refused (409) rather
 * than acting on another folder. */
export const WorkspaceRootContext = createContext<string | undefined>(undefined)

export const workspaceKey = (agentId: string) => ['team', 'workspace', agentId] as const
export const treeKey = (agentId: string, path: string, root?: string) =>
  [...workspaceKey(agentId), 'tree', root ?? '', path] as const
export const fileKey = (agentId: string, path: string, root?: string) =>
  [...workspaceKey(agentId), 'file', root ?? '', path] as const

const IMAGE = /\.(png|jpe?g|gif|webp)$/i
export const isImagePath = (path: string) => IMAGE.test(path)
export const isPdfPath = (path: string) => /\.pdf$/i.test(path)
export const fileUrl = (agentId: string, path: string, download = false, root?: string) =>
  `/api/${withPath(agentId, 'file', path, download ? '&download=1' : '', root)}`

export function useWorkspace(agentId: string) {
  return useQuery({
    queryKey: workspaceKey(agentId),
    queryFn: async ({ signal }) =>
      WorkspaceInfoSchema.parse(await apiFetch(base(agentId), { signal })),
    // The folder is configured in Hermes and can change outside Score.
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
    retry: false,
  })
}

/** Branch and changed-file count of the repository around the root; null when there is none. */
export function useGitStatus(agentId: string) {
  const root = useContext(WorkspaceRootContext)
  return useQuery({
    queryKey: [...workspaceKey(agentId), 'git', root ?? ''] as const,
    queryFn: async ({ signal }) =>
      WorkspaceGitSchema.nullable().parse(
        await apiFetch(
          `${base(agentId)}/git${root === undefined ? '' : `?root=${encodeURIComponent(root)}`}`,
          {
            signal,
          },
        ),
      ),
    // The agent edits and commits while Score is open.
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
    retry: false,
  })
}

export function useTree(agentId: string, path: string, enabled = true) {
  const root = useContext(WorkspaceRootContext)
  return useQuery({
    queryKey: treeKey(agentId, path, root),
    enabled,
    queryFn: async ({ signal }) =>
      WorkspaceTreeSchema.parse(
        await apiFetch(withPath(agentId, 'tree', path, '', root), { signal }),
      ).entries,
    // The agent changes files while Score is open: look again when the window regains focus.
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  })
}

export type LoadedFile =
  | { kind: 'text'; content: string; etag: string }
  | { kind: 'binary'; size: number; reason: 'binary' | 'too_large' }

/** Text comes back as text/plain with an ETag header; everything else previewable is shown by URL. */
export async function fetchFile(
  agentId: string,
  path: string,
  signal?: AbortSignal,
  root?: string,
): Promise<LoadedFile> {
  const response = await fetch(fileUrl(agentId, path, false, root), {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  })
  const type = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null)
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'Couldn’t complete that. Try again.',
    )
  }
  if (type.startsWith('application/json')) {
    const binary = WorkspaceBinarySchema.parse(await response.json())
    return { kind: 'binary', size: binary.size, reason: binary.reason }
  }
  const etag = (response.headers.get('etag') ?? '').replace(/^"|"$/g, '')
  return { kind: 'text', content: await response.text(), etag }
}

export function useFile(agentId: string, path: string, enabled: boolean) {
  const root = useContext(WorkspaceRootContext)
  return useQuery({
    queryKey: fileKey(agentId, path, root),
    enabled,
    queryFn: ({ signal }) => fetchFile(agentId, path, signal, root),
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })
}

export function conflictOf(error: unknown): { etag: string | null } | null {
  if (!(error instanceof ApiError) || error.status !== 412) return null
  const parsed = WorkspaceConflictSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

/** One plain sentence for a failed workspace action. */
export function workspaceFailure(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'not_paired')
      return `Pair this browser using the link in the server terminal to ${action}.`
    if (
      [
        'workspace_unavailable',
        'workspace_changed',
        'exists',
        'not_empty',
        'blocked',
        'bad_path',
        'symlink',
      ].includes(error.code)
    )
      return error.message
    if (error.code === 'payload_too_large') return 'That is too large for the workspace.'
    if (error.status === 404) return 'That is no longer there.'
    if (error.status === 403) return error.message
  }
  return `Couldn’t ${action}. Try again.`
}

export function useWorkspaceActions(agentId: string) {
  const queryClient = useQueryClient()
  const root = useContext(WorkspaceRootContext)
  const refreshTree = () =>
    queryClient.invalidateQueries({ queryKey: [...workspaceKey(agentId), 'tree'] })
  // The folder was changed elsewhere: look at the workspace again so the view follows it.
  const refreshInfo = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'workspace_changed')
      void queryClient.invalidateQueries({ queryKey: workspaceKey(agentId) })
  }
  const json = (method: string, tail: string, body: unknown, withRoot = true) =>
    apiFetch(
      `${base(agentId)}/${tail}${withRoot && root !== undefined ? `?root=${encodeURIComponent(root)}` : ''}`,
      { method, body: JSON.stringify(body) },
    )
  return {
    setRoot: useMutation({
      mutationFn: async (path: string) =>
        WorkspaceInfoSchema.parse(await json('PUT', 'root', { path }, false)),
      onSuccess: async () => {
        queryClient.removeQueries({ queryKey: [...workspaceKey(agentId), 'tree'] })
        await queryClient.invalidateQueries({ queryKey: workspaceKey(agentId) })
      },
    }),
    save: useMutation({
      mutationFn: async (req: { path: string; content: string; etag: string | null }) =>
        WorkspaceWriteResponseSchema.parse(
          await apiFetch(withPath(agentId, 'file', req.path, '', root), {
            method: 'PUT',
            body: JSON.stringify({ content: req.content, etag: req.etag }),
          }),
        ).etag,
      onSuccess: refreshTree,
      onError: refreshInfo,
    }),
    create: useMutation({
      mutationFn: (req: { path: string; kind: 'file' | 'dir' }) => json('POST', 'entries', req),
      onSuccess: refreshTree,
      onError: refreshInfo,
    }),
    move: useMutation({
      mutationFn: (req: { from: string; to: string }) => json('POST', 'move', req),
      onSuccess: refreshTree,
      onError: refreshInfo,
    }),
    remove: useMutation({
      mutationFn: (req: { path: string; recursive: boolean }) =>
        apiFetch(
          withPath(agentId, 'entries', req.path, req.recursive ? '&recursive=1' : '', root),
          {
            method: 'DELETE',
          },
        ),
      onSuccess: refreshTree,
      onError: refreshInfo,
    }),
    upload: useMutation({
      mutationFn: (req: { path: string; file: File }) =>
        apiFetch(withPath(agentId, 'upload', req.path, '', root), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: req.file,
        }),
      onSuccess: refreshTree,
      onError: refreshInfo,
    }),
  }
}

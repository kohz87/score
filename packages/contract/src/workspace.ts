import { z } from 'zod'

// Contract §8 (Team › agent › Workspace): the agent's working folder, browsed and edited from Score.
// Paths are POSIX, relative to the workspace root.
export const WorkspaceInfoSchema = z.object({
  /** The resolved folder, or null when none is usable. */
  root: z.string().nullable(),
  available: z.boolean(),
  /** Why the workspace is unavailable (remote backend, unset folder, refused folder); null when available. */
  reason: z.string().nullable(),
})
export const WorkspaceEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['file', 'dir', 'symlink']),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  hidden: z.boolean(),
})
export const WorkspaceTreeSchema = z.object({ entries: z.array(WorkspaceEntrySchema) })
/** `GET …/workspace/file` for anything that is not shown as text, image or PDF. */
export const WorkspaceBinarySchema = z.object({
  binary: z.literal(true),
  size: z.number().int().nonnegative(),
  reason: z.enum(['binary', 'too_large']),
})
export const WorkspaceWriteRequestSchema = z.object({
  content: z.string(),
  /** The etag the editor loaded; null creates a new file and refuses an existing one. */
  etag: z.string().nullable(),
})
export const WorkspaceWriteResponseSchema = z.object({ etag: z.string() })
export const WorkspaceCreateRequestSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
})
export const WorkspaceMoveRequestSchema = z.object({ from: z.string().min(1), to: z.string().min(1) })
export const WorkspaceRootRequestSchema = z.object({ path: z.string().min(1).max(4096) })
export const WorkspaceUploadResponseSchema = z.object({ path: z.string(), size: z.number().int() })
/** 412 `precondition_failed`: `details.etag` is the file's current etag (null when it was removed). */
export const WorkspaceConflictSchema = z.object({ etag: z.string().nullable() })

export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>
export type WorkspaceBinary = z.infer<typeof WorkspaceBinarySchema>

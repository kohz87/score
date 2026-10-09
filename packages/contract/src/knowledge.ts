import { z } from 'zod'

// Contract §12 (Knowledge): the central vault of Markdown notes (design docs/briefs/6.0-workspace-knowledge.md § 6.2).
// Paths are POSIX, relative to the vault, and end in `.md` for notes.
export const KnowledgeAuthorSchema = z.union([
  z.literal('you'),
  z.literal('outside'),
  z.object({ agentId: z.string().min(1) }),
])
export const KnowledgeInfoSchema = z.object({
  /** The vault folder on the Score machine. */
  vault: z.string(),
  notes: z.number().int().nonnegative(),
  /** False when git is missing or the vault is not a usable repository: notes still save, history is unavailable. */
  gitAvailable: z.boolean(),
  /** Whether agents may use the knowledge tools at all (Settings › Knowledge). */
  agentAccess: z.boolean(),
})
export const KnowledgeNoteSummarySchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  mtime: z.string(),
  /** Who last changed it through Score (git author), or null when unknown. */
  lastAuthor: KnowledgeAuthorSchema.nullable(),
})
export const KnowledgeTreeSchema = z.object({
  folders: z.array(z.string()),
  notes: z.array(KnowledgeNoteSummarySchema),
})
export const KnowledgeLinkSchema = z.object({
  /** The link as written (`Target`, `Target#heading`). */
  target: z.string(),
  /** The note it resolves to, or null for a missing note. */
  path: z.string().nullable(),
})
export const KnowledgeNoteSchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  /** Parsed YAML frontmatter (values as JSON); `{}` when there is none. */
  frontmatter: z.record(z.string(), z.unknown()),
  /** The Markdown body without the frontmatter block. */
  body: z.string(),
  etag: z.string(),
  mtime: z.string(),
  links: z.array(KnowledgeLinkSchema),
  backlinks: z.array(z.object({ path: z.string(), title: z.string() })),
  lastAuthor: KnowledgeAuthorSchema.nullable(),
})
export const KnowledgeWriteRequestSchema = z.object({
  body: z.string().max(2 * 1024 * 1024),
  /** Replaces the frontmatter when present; omitted keeps the current one. */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** The etag the editor loaded; null creates the note and refuses an existing one. */
  etag: z.string().nullable(),
})
export const KnowledgeWriteResponseSchema = z.object({ etag: z.string(), path: z.string() })
export const KnowledgeMoveRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Rewrite `[[links]]` to the moved note in other notes, in the same commit. */
  updateLinks: z.boolean(),
})
export const KnowledgeMoveResponseSchema = z.object({
  path: z.string(),
  /** How many other notes had links rewritten. */
  updatedNotes: z.number().int().nonnegative(),
})
export const KnowledgeSearchHitSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** Plain text around the match; `[[` `]]` mark matched terms (the client renders them as highlights). */
  snippet: z.string(),
})
export const KnowledgeSearchResponseSchema = z.object({ items: z.array(KnowledgeSearchHitSchema) })
export const KnowledgeCommitSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  at: z.string(),
  author: KnowledgeAuthorSchema,
  message: z.string(),
})
export const KnowledgeHistorySchema = z.object({ items: z.array(KnowledgeCommitSchema) })
export const KnowledgeVersionSchema = z.object({ commit: z.string(), body: z.string() })
export const KnowledgeRestoreRequestSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
})
/** 412 `precondition_failed`: `details.etag` is the note's current etag (null when it was removed). */
export const KnowledgeConflictSchema = z.object({ etag: z.string().nullable() })
export const KnowledgeChangedSchema = z.object({
  path: z.string(),
  /** Null path change for a delete; `to` set for a move. */
  kind: z.enum(['written', 'moved', 'deleted', 'restored']),
  to: z.string().nullable(),
  by: KnowledgeAuthorSchema,
})

export type KnowledgeAuthor = z.infer<typeof KnowledgeAuthorSchema>
export type KnowledgeInfo = z.infer<typeof KnowledgeInfoSchema>
export type KnowledgeNoteSummary = z.infer<typeof KnowledgeNoteSummarySchema>
export type KnowledgeTree = z.infer<typeof KnowledgeTreeSchema>
export type KnowledgeLink = z.infer<typeof KnowledgeLinkSchema>
export type KnowledgeNote = z.infer<typeof KnowledgeNoteSchema>
export type KnowledgeWriteRequest = z.infer<typeof KnowledgeWriteRequestSchema>
export type KnowledgeMoveRequest = z.infer<typeof KnowledgeMoveRequestSchema>
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHitSchema>
export type KnowledgeCommit = z.infer<typeof KnowledgeCommitSchema>
export type KnowledgeChanged = z.infer<typeof KnowledgeChangedSchema>

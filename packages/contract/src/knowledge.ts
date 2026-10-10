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
  /** Uploaded documents (PDF, DOCX, CSV, images, zips, ...) and their total size on disk (task 6.6). */
  documents: z.number().int().nonnegative().default(0),
  documentBytes: z.number().int().nonnegative().default(0),
})
export const KnowledgeNoteSummarySchema = z.object({
  path: z.string().min(1),
  title: z.string(),
  mtime: z.string(),
  /** Who last changed it through Score (git author), or null when unknown. */
  lastAuthor: KnowledgeAuthorSchema.nullable(),
})
// Task 6.6: documents are files in the vault that are not Markdown notes.
export const KnowledgeDocumentTypeSchema = z.enum([
  'pdf',
  'docx',
  'csv',
  'json',
  'html',
  'image',
  'zip',
])
/**
 * `indexed`: text extracted and searchable; `truncated`: indexed, the text was cut at 2 MiB; `unavailable`: extraction
 * failed or no extractor; `none`: not indexed by design (images, zips).
 */
export const KnowledgeTextStatusSchema = z.enum(['indexed', 'truncated', 'unavailable', 'none'])
export const KnowledgeDocumentSummarySchema = z.object({
  path: z.string().min(1),
  type: KnowledgeDocumentTypeSchema,
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  lastAuthor: KnowledgeAuthorSchema.nullable(),
  /** Committed to the vault's git (documents up to 10 MB); larger ones are stored but not versioned. */
  versioned: z.boolean(),
  textStatus: KnowledgeTextStatusSchema,
})
export const KnowledgeTreeSchema = z.object({
  folders: z.array(z.string()),
  notes: z.array(KnowledgeNoteSummarySchema),
  documents: z.array(KnowledgeDocumentSummarySchema).default([]),
})
export const KnowledgeZipEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
})
export const KnowledgeDocumentSchema = KnowledgeDocumentSummarySchema.extend({
  /** Extracted text (redacted, at most 2 MiB); '' when none. */
  text: z.string(),
  /** Zip documents: the file list (at most 1,000 names). */
  entries: z.array(KnowledgeZipEntrySchema).nullable(),
})
export const KnowledgeUploadConflictSchema = z.enum(['ask', 'keep', 'replace'])
export const KnowledgeUploadResultSchema = z.object({
  /** Where the file ended up (`.txt` becomes a `.md` note; `keep` may add a suffix). */
  path: z.string(),
  kind: z.enum(['note', 'document']),
  replaced: z.boolean(),
})
/** 409 `exists` details of an upload: what is already there (and, for an unzip, which names clash). */
export const KnowledgeExistsDetailsSchema = z.object({
  existing: z.array(z.object({ path: z.string(), mtime: z.string(), size: z.number() })).max(50),
})
export const KnowledgeZipPreviewSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().nonnegative(),
      /** `extract`, or `skip` with the reason in plain words. */
      action: z.enum(['extract', 'skip']),
      reason: z.string().nullable(),
    }),
  ),
  /** True when the listing was cut at 1,000 names. */
  more: z.boolean(),
  extractCount: z.number().int().nonnegative(),
})
export const KnowledgeUnzipResultSchema = z.object({
  folder: z.string(),
  written: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
})
export const KnowledgeFolderRequestSchema = z.object({ path: z.string().min(1).max(1024) })
export const KnowledgeFromMediaRequestSchema = z.object({
  mediaId: z.string().min(1).max(64),
  /** Destination path including the file name. */
  path: z.string().min(1).max(1024),
  onConflict: KnowledgeUploadConflictSchema.default('ask'),
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
  /** `document` hits (PDF, DOCX, CSV, ...) carry their file type for the badge. */
  kind: z.enum(['note', 'document']).default('note'),
  type: KnowledgeDocumentTypeSchema.nullable().default(null),
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
export type KnowledgeDocumentSummary = z.infer<typeof KnowledgeDocumentSummarySchema>
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>
export type KnowledgeDocumentType = z.infer<typeof KnowledgeDocumentTypeSchema>
export type KnowledgeUploadResult = z.infer<typeof KnowledgeUploadResultSchema>
export type KnowledgeZipPreview = z.infer<typeof KnowledgeZipPreviewSchema>
export type KnowledgeUnzipResult = z.infer<typeof KnowledgeUnzipResultSchema>
export type KnowledgeChanged = z.infer<typeof KnowledgeChangedSchema>

// Contract §11/§12 (task 6.4): agent knowledge tools over the bridge, and their switches and counters.
const AGENT_NOTE_BYTES = 256 * 1024
export const KnowledgeToolPathSchema = z.string().min(1).max(1024)
export const BridgeKnowledgeSearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.int().min(1).max(20).default(20),
})
export const BridgeKnowledgeReadRequestSchema = z.object({ path: KnowledgeToolPathSchema })
export const BridgeKnowledgeListRequestSchema = z.object({
  folder: z.string().max(1024).optional(),
})
export const BridgeKnowledgeWriteRequestSchema = z.object({
  path: KnowledgeToolPathSchema,
  // Counted in bytes by the server (413); the schema cap is only a parse guard.
  body: z.string().max(AGENT_NOTE_BYTES * 4),
  expectedEtag: z.string().min(1).max(256).nullable(),
})
export const BridgeKnowledgeAppendRequestSchema = z.object({
  path: KnowledgeToolPathSchema,
  text: z
    .string()
    .min(1)
    .max(AGENT_NOTE_BYTES * 4),
})
export const BridgeKnowledgeSearchResponseSchema = z.object({
  items: z.array(KnowledgeSearchHitSchema).max(200),
})
export const BridgeKnowledgeReadResponseSchema = z.object({
  path: z.string(),
  title: z.string(),
  body: z.string(),
  etag: z.string(),
  /** The body was cut at 256 KiB; the etag is still the whole note's. */
  truncated: z.boolean(),
  /** `document`: `body` is the extracted text of an uploaded file (PDF, DOCX, ...), '' when none was available. */
  kind: z.enum(['note', 'document']).default('note'),
  /** Set when a document's text is missing or was cut, so the agent can say so. */
  notice: z.string().nullable().default(null),
})
export const BridgeKnowledgeListResponseSchema = z.object({
  folders: z.array(z.string()),
  notes: z.array(z.object({ path: z.string(), title: z.string(), mtime: z.string() })),
  /** Uploaded documents (read with knowledge_read: returns their extracted text). */
  documents: z
    .array(
      z.object({
        path: z.string(),
        type: KnowledgeDocumentTypeSchema,
        size: z.number(),
        mtime: z.string(),
      }),
    )
    .default([]),
  /** More than 200 entries matched; narrow with `folder`. */
  truncated: z.boolean(),
})
export const BridgeKnowledgeWriteResponseSchema = KnowledgeWriteResponseSchema

export const KnowledgeAgentAccessSchema = z.object({ enabled: z.boolean() })
export const KnowledgeAgentUsageSchema = z.object({
  items: z.array(z.object({ agentId: z.string(), writesToday: z.int().nonnegative() })),
})
export type KnowledgeAgentUsage = z.infer<typeof KnowledgeAgentUsageSchema>

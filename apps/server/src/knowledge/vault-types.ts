import { z } from 'zod'
import type { KnowledgeChanged, KnowledgeHistoryStatus } from '@score/contract'
import { KnowledgeAuthorSchema } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'

export interface VaultLog {
  warn(object: object, message: string): void
}

export interface VaultOptions {
  vault: string
  db: ScoreDb
  /** Publishes `knowledge.changed`; failures are logged, never thrown into a save. */
  emit: (change: KnowledgeChanged) => void | Promise<unknown>
  log?: VaultLog
  now?: () => number
  /** Quiet time after the last file-system event before a scan. */
  debounceMs?: number
  /** Full scan interval (covers missed watcher events). */
  scanIntervalMs?: number
  /** Fake mode: write neutral example notes into an empty vault. */
  seed?: boolean
  /** Tests: do not use fs.watch. */
  watch?: boolean
  /** Score's own state for Knowledge (`$SCORE_HOME/knowledge`): the move plan lives here, never in the vault. */
  stateDir?: string
  /** Tests: first retry delay for an interrupted move that couldn't be finished (doubles up to 5 minutes). */
  moveRetryMs?: number
}

export const NoteRowSchema = z.object({
  id: z.number(),
  path: z.string(),
  title: z.string(),
  mtime_ms: z.number(),
  size: z.number(),
  hash: z.string(),
  frontmatter_json: z.string(),
  last_author: z.string().nullable(),
})
export type NoteRow = z.infer<typeof NoteRowSchema>
export const LinkRowSchema = z.object({
  rowid: z.number(),
  from_path: z.string(),
  to_target: z.string(),
  to_path: z.string().nullable(),
})

export const FileIdentitySchema = z.object({
  dev: z.number(),
  ino: z.number(),
  birthtimeMs: z.number(),
  size: z.number(),
  /** Content hash; absent for the identity read off the destination right after the rename. */
  hash: z.string().optional(),
})
export type FileIdentity = z.infer<typeof FileIdentitySchema>

export const MovePlanSchema = z.object({
  from: z.string(),
  to: z.string(),
  author: KnowledgeAuthorSchema,
  items: z.array(
    z.object({
      path: z.string(),
      baseHash: z.string(),
      newHash: z.string(),
      content: z.string(),
      done: z.boolean(),
      skipped: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  /** Older versions parked the old name while removing it; such a plan is only reported, never interpreted. */
  parked: z.string().optional(),
  /** What the source was before the move; recovery accepts the destination as the moved file only if it matches. */
  identity: FileIdentitySchema.optional(),
  /** `conflicted`: recovery found the evidence doesn't add up; the plan is kept, shown, and not retried. */
  state: z.enum(['active', 'conflicted']).default('active'),
  detail: z.string().optional(),
})
export type MovePlan = z.infer<typeof MovePlanSchema>
/** Kept in memory and shown on the Knowledge page while a move plan needs attention. */
export interface MoveIssue {
  state: 'pending' | 'conflicted'
  from: string
  to: string
  message: string
}
export interface MoveSkipped {
  path: string
  reason: string
}

export const READ_CHUNK_BYTES = 256 * 1024
export const MAX_FILES = 100_000
export const MAX_DEPTH = 32
export const MAX_EVENTS_PER_SCAN = 200
export const README = `# Knowledge

Notes shared by you and your agents. Plain Markdown files with optional frontmatter; link notes with [[wikilinks]].
Every save is a git commit, so nothing is ever lost.
`

/** A stat that failed because the path is genuinely gone (anything else is "couldn't verify"). */
export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export interface HistoryOutcome {
  history: KnowledgeHistoryStatus
  /** False when the path has no history by design or because git is missing. */
  versioned: boolean
  /** False when the save did not reach history (`failed`, `git_unavailable`). */
  historyUpdated: boolean
}

export function historyOutcome(
  history: KnowledgeHistoryStatus,
  partlyIgnored = false,
): HistoryOutcome {
  return {
    history,
    versioned: !partlyIgnored && history !== 'not_versioned' && history !== 'git_unavailable',
    historyUpdated: history !== 'failed' && history !== 'git_unavailable',
  }
}

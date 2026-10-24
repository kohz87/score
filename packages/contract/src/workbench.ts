import { z } from 'zod'
import { ResultDraftSchema } from './results.ts'
import { AgentIdSchema, WatchFrameSchema } from './types.ts'

// A job's Workbench (PLAN 11.6a; design docs/briefs/11.0-bold.md §10): who wrote which line of the files the job changed,
// the review notes pinned to lines, where each agent last edited, the drafts and each agent's latest screen. Derived on
// read from the job's editor watch frames and review actions. Read-only: nothing here types, clicks or takes over.

const at = z.iso.datetime()

export const WorkbenchLineSchema = z.object({
  /** The line's number in the file as it is now. */
  n: z.int().positive(),
  text: z.string(),
  /** The agent whose edit wrote this line; null for a line Score only saw as context (written before the job). */
  by: AgentIdSchema.nullable(),
})

export const WorkbenchCommentSchema = z.object({
  id: z.string().min(1),
  by: AgentIdSchema,
  /** Where the note's line is now; null once that line was changed or removed (`outdated`). */
  line: z.int().positive().nullable(),
  /** The line the note was written on. */
  originalLine: z.int().positive(),
  text: z.string(),
  outdated: z.boolean(),
  exchangeId: z.string().nullable(),
  /** The review action the note came with. */
  kind: z.enum(['review', 'approve', 'send_back']),
  at,
})

export const WorkbenchFileSchema = z.object({
  path: z.string().min(1),
  language: z.string().nullable(),
  /** False when an edit had no known position in the file or a diff was cut short: authorship may be off. */
  exact: z.boolean(),
  /** Lines Score knows (edited or seen as context), in order; other lines exist but Score never saw them. */
  lines: z.array(WorkbenchLineSchema),
  /** Each agent's last edit position in this file ("cursor"); null when that position was later removed. */
  cursors: z.array(z.object({ agentId: AgentIdSchema, line: z.int().positive().nullable(), at })),
  comments: z.array(WorkbenchCommentSchema),
  editedBy: z.array(AgentIdSchema),
  lastEditAt: at,
})

export const WorkbenchSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  files: z.array(WorkbenchFileSchema),
  /** Notes on paths the job never edited (still shown, so nothing a reviewer wrote is lost). */
  looseComments: z.array(WorkbenchCommentSchema.extend({ path: z.string() })),
  drafts: z.array(ResultDraftSchema),
  /** Each agent's latest watch frame in the job, as Watch shows it (read-only). */
  screens: z.array(z.object({ frame: WatchFrameSchema, live: z.boolean() })),
})

export type Workbench = z.infer<typeof WorkbenchSchema>
export type WorkbenchFile = z.infer<typeof WorkbenchFileSchema>
export type WorkbenchComment = z.infer<typeof WorkbenchCommentSchema>

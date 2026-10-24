import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// A job's results for the side panel's Work › Results (PLAN 11.2b, docs/briefs/11.2-contract.md; design
// docs/briefs/11.0-bold.md §10). Derived on read from what Score records for the job's runs: changed files, exchange
// outcomes, watch frames and attachments. Each card links to its Workbench tab; nothing here is raw code.

const at = z.iso.datetime()

export const ResultChangeLineSchema = z.object({
  /** Plain words: "Approved by reviewer", or a send-back's first line. */
  text: z.string(),
  by: AgentIdSchema.nullable(),
  /** A reviewer caught something that was then fixed ("reviewer caught this"). */
  caught: z.boolean(),
})

/** A document or workspace file an agent attached in the job (also listed in the Workbench). */
export const ResultDraftSchema = z.object({
  kind: z.literal('draft'),
  id: z.string().min(1),
  agentId: AgentIdSchema,
  title: z.string(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('document'), mediaId: z.string().min(1) }),
    z.object({ kind: z.literal('workspace'), path: z.string().min(1) }),
  ]),
  at,
})

export const ResultCardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('change'),
    id: z.string().min(1),
    title: z.string(),
    authors: z.array(AgentIdSchema),
    /** `in_review`, `sent_back` and `approved` come from the job's latest review. */
    state: z.enum(['working', 'in_review', 'sent_back', 'approved', 'waiting_on_you', 'done']),
    whatChanged: z.array(ResultChangeLineSchema),
    files: z.array(
      z.object({
        path: z.string(),
        added: z.int().nonnegative(),
        removed: z.int().nonnegative(),
        by: z.array(AgentIdSchema),
      }),
    ),
    at,
  }),
  z.object({
    kind: z.literal('preview'),
    id: z.string().min(1),
    agentId: AgentIdSchema,
    url: z.string(),
    title: z.string().nullable(),
    imageUrl: z.string().nullable(),
    /** Its run is still going: the preview may change. */
    live: z.boolean(),
    at,
  }),
  ResultDraftSchema,
])
export type ResultCard = z.infer<typeof ResultCardSchema>

/** `GET /api/jobs/:jobId/results`. `screens`: each agent's newest watch frame in the job (its small live screen). */
export const JobResultsSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(ResultCardSchema),
  screens: z.array(
    z.object({
      agentId: AgentIdSchema,
      seq: z.int().positive(),
      surface: z.enum(['terminal', 'editor', 'browser']),
      caption: z.string(),
      live: z.boolean(),
      at,
    }),
  ),
})
export type JobResults = z.infer<typeof JobResultsSchema>

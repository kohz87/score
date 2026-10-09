import { z } from 'zod'
import {
  AgentIdSchema,
  ApprovalSchema,
  AttemptSummarySchema,
  LogLineSchema,
  RunSummarySchema,
  TaskStepSchema,
} from './types.ts'

// §4 Flow. A brief is a human room message plus what it causes; see the 3.4 design review.
export const BriefStatusSchema = z.enum(['running', 'paused', 'done', 'failed'])
export type BriefStatus = z.infer<typeof BriefStatusSchema>

export const BriefSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  roomId: z.string().min(1),
  startedAt: z.iso.datetime(),
  startedBy: z.union([z.literal('you'), AgentIdSchema]),
  status: BriefStatusSchema,
})
export type BriefSummary = z.infer<typeof BriefSummarySchema>

export const BriefsListSchema = z.object({ items: z.array(BriefSummarySchema) })
export type BriefsList = z.infer<typeof BriefsListSchema>

export const FlowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['brief', 'step']),
  title: z.string(),
  agentId: AgentIdSchema.nullable(),
  state: z.enum(['done', 'working', 'needs_you', 'planned', 'failed']),
  subtitle: z.string(),
  taskId: z.string().min(1).nullable(),
  layout: z.object({ col: z.int().nonnegative(), row: z.int().nonnegative() }),
})
export type FlowNode = z.infer<typeof FlowNodeSchema>

export const FlowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['flow', 'handoff', 'review', 'sent_back', 'planned']),
  label: z.string().nullable(),
})
export type FlowEdge = z.infer<typeof FlowEdgeSchema>

export const BriefFlowSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  brief: BriefSummarySchema,
  nodes: z.array(FlowNodeSchema).max(200),
  edges: z.array(FlowEdgeSchema),
  stats: z.object({
    runningSec: z.int().nonnegative(),
    steps: z.int().nonnegative(),
    handoffs: z.int().nonnegative(),
    spendUsd: z.number().nonnegative().nullable(),
    eta: z.string().nullable(),
    /** Kanban attempts counted in `runningSec`; their cost is unknown, so `spendUsd` is null while any exist. */
    attempts: z.int().nonnegative().optional(),
  }),
  /** Set when the brief's agents also worked on tasks not linked to it (links are exact, never guessed). */
  notice: z.string().nullable(),
})
export type BriefFlow = z.infer<typeof BriefFlowSchema>

export const FlowNodeDetailSchema = z.object({
  node: FlowNodeSchema,
  description: z.string(),
  steps: z.array(TaskStepSchema),
  approval: ApprovalSchema.nullable(),
  run: RunSummarySchema.nullable(),
  model: z.string().nullable(),
  /** null = not observed (a Kanban attempt records no tool use); an empty array = observed, none used. */
  tools: z.array(z.string()).nullable(),
  /** Kanban attempts of this step, ordered by `order` (present only with attempts enabled). */
  attempts: z.array(AttemptSummarySchema).optional(),
  watch: z
    .object({
      agentId: AgentIdSchema,
      thumbnail: z.string().nullable(),
      front: z.string(),
    })
    .nullable(),
})
export type FlowNodeDetail = z.infer<typeof FlowNodeDetailSchema>

export const BriefLogPageSchema = z.object({
  items: z.array(LogLineSchema),
  nextCursor: z.string().nullable(),
})
export type BriefLogPage = z.infer<typeof BriefLogPageSchema>

export const PlanStartResponseSchema = z.object({
  briefId: z.string().min(1),
  taskIds: z.array(z.string().min(1)),
})
export type PlanStartResponse = z.infer<typeof PlanStartResponseSchema>

export const NodeStopResponseSchema = z.object({ ok: z.literal(true) })

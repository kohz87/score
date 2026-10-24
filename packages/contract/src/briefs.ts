import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

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

export const PlanStartResponseSchema = z.object({
  briefId: z.string().min(1),
  taskIds: z.array(z.string().min(1)),
})
export type PlanStartResponse = z.infer<typeof PlanStartResponseSchema>

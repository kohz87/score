import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// 2.3.0 (decision 128): an agent's clarify question to the person (Hermes 0.22.5 `clarify.request` on a Score run).
// Its own entity, never an Approval: Guardian, rules and "always" never answer a question.
export const AgentQuestionAnswerSchema = z.union([
  z.string().trim().min(1).max(16384),
  z.array(z.string().min(1)).min(1).max(50),
])
export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>

export const AgentQuestionSchema = z.object({
  id: z.string().min(1),
  agentId: AgentIdSchema,
  runId: z.string().min(1),
  roomId: z.string().min(1).nullable(),
  jobId: z.string().min(1).nullable(),
  question: z.string(),
  /** The agent's choices; empty means a free-text answer. */
  options: z.array(z.string()),
  /** Several options may be picked (only with options). */
  multiSelect: z.boolean(),
  status: z.enum(['pending', 'answered', 'expired', 'withdrawn']),
  answer: AgentQuestionAnswerSchema.nullable(),
  /** `elsewhere`: answered in Hermes itself; `timeout`: Hermes stopped waiting. */
  answeredBy: z.enum(['you', 'elsewhere', 'timeout']).nullable(),
  delivery: z.enum(['none', 'delivering', 'applied', 'failed']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  answeredAt: z.iso.datetime().nullable(),
})
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>

export const AgentQuestionListSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(AgentQuestionSchema),
})
export type AgentQuestionList = z.infer<typeof AgentQuestionListSchema>

export const AnswerQuestionRequestSchema = z.object({ answer: AgentQuestionAnswerSchema }).strict()
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>

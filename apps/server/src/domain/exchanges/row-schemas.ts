import { ExchangeSchema, JobSchema } from '@score/contract'
import { z } from 'zod'

export const JobRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  title: z.string(),
  state: JobSchema.shape.state,
  holder_agent_id: z.string().nullable(),
  is_default: z.union([z.literal(0), z.literal(1)]),
  source: z.string().nullable(),
  exchange_budget: z.int(),
  job_turn_limit: z.int(),
  spend_cap_usd: z.number().nullable(),
  subagents_enabled: z.int(),
  subagents_max_concurrent: z.int().nullable(),
  subagents_max_total: z.int(),
  subagents_used: z.int(),
  recipe_kind: z.enum(['orchestration', 'workflow']).nullable(),
  recipe_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type JobRow = z.infer<typeof JobRowSchema>

export const ExchangeRowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  room_id: z.string(),
  kind: ExchangeSchema.shape.kind,
  parent_id: z.string().nullable(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  state: ExchangeSchema.shape.state,
  round: z.int(),
  turns_used: z.int(),
  budget: z.int(),
  outcome: ExchangeSchema.shape.outcome,
  ended_reason: z.string().nullable(),
  lead_extended: z.union([z.literal(0), z.literal(1)]),
  pause_reason: z
    .enum([
      'exchange_budget',
      'job_limit',
      'spend_cap',
      'cost_unknown',
      'turn_failed',
      'unreachable',
      'asker_gone',
      'no_decision',
      'author_stalled',
      'question_stopped',
      'subagent_total',
    ])
    .nullable(),
  held: z.string().nullable(),
  decider_turn_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>

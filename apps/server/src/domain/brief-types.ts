import { z } from 'zod'

export const BriefRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  title: z.string(),
  started_at: z.iso.datetime(),
  started_by: z.string(),
  paused_at: z.iso.datetime().nullable(),
  emitted_status: z.string().nullable(),
})
export type BriefRow = z.infer<typeof BriefRowSchema>

export type BriefTaskOrigin = 'assign' | 'plan' | 'child'

export const TaskIdRowSchema = z.object({ task_id: z.string() })
export const IdRowSchema = z.object({ id: z.string() })

export interface TurnRow {
  message_id: string
  agent_id: string
  hop: number
  turn_id: string
  parent_message_id: string
  from_agent_id: string | null
  state: 'pending' | 'active' | 'completed' | 'failed'
  run_id: string | null
  run_status: string | null
  created_at: string
}
export const TurnRowSchema = z.object({
  message_id: z.string(),
  agent_id: z.string(),
  hop: z.int(),
  turn_id: z.string(),
  parent_message_id: z.string(),
  from_agent_id: z.string().nullable(),
  state: z.enum(['pending', 'active', 'completed', 'failed']),
  run_id: z.string().nullable(),
  run_status: z.string().nullable(),
  created_at: z.string(),
})

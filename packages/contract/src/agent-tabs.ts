import { z } from 'zod'
import { AgentDetailSchema } from './types.ts'

// Contract §8: response bodies of the Team tabs (skills, skills hub, memory).
export const SkillItemSchema = AgentDetailSchema.shape.skills.element
export const MemoryItemSchema = AgentDetailSchema.shape.memory.element
export const HubSkillSchema = z.object({
  name: z.string(),
  identifier: z.string().min(1),
  source: z.string(),
  trust: z.string(),
  description: z.string(),
})
export const SkillsResponseSchema = z.object({ items: AgentDetailSchema.shape.skills })
export const SkillHubResponseSchema = z.object({ items: z.array(HubSkillSchema) })
export const MemoryPageSchema = z.object({
  items: AgentDetailSchema.shape.memory,
  nextCursor: z.string().nullable(),
})
export type SkillItem = z.infer<typeof SkillItemSchema>
export type MemoryItem = z.infer<typeof MemoryItemSchema>
export type HubSkill = z.infer<typeof HubSkillSchema>
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>
export type SkillHubResponse = z.infer<typeof SkillHubResponseSchema>
export type MemoryPage = z.infer<typeof MemoryPageSchema>

import { z } from 'zod'
import { AgentDetailSchema, RunSummarySchema } from './types.ts'

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
  // false when Hermes offers no way to change single entries; absent means writable.
  writable: z.boolean().optional(),
})
export type SkillItem = z.infer<typeof SkillItemSchema>
export type MemoryItem = z.infer<typeof MemoryItemSchema>
export type HubSkill = z.infer<typeof HubSkillSchema>
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>
export type SkillHubResponse = z.infer<typeof SkillHubResponseSchema>
export type MemoryPage = z.infer<typeof MemoryPageSchema>

// Contract §8: Channels and History tabs.
export const AgentChannelSchema = z.object({
  platform: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['connected', 'disconnected']),
  detail: z.string().nullable(),
  /** The exact command to run in a terminal; Score never runs the interactive setup itself. */
  connectCommand: z.string().min(1),
})
export const AgentChannelsResponseSchema = z.object({ items: z.array(AgentChannelSchema) })
export const HistoryOutcomeSchema = z.enum([
  'completed',
  'failed',
  'stopped',
  'interrupted',
  'waiting',
  'running',
  'unknown',
])
export const AgentHistoryItemSchema = z.object({
  runId: z.string().min(1),
  title: z.string(),
  origin: RunSummarySchema.shape.origin,
  outcome: HistoryOutcomeSchema,
  startedAt: z.iso.datetime(),
  durationSec: z.int().nonnegative().nullable(),
  model: z.string().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  task: z.object({ id: z.string().min(1), title: z.string() }).nullable(),
  brief: z.object({ id: z.string().min(1), title: z.string() }).nullable(),
  /** First Watch frame of this run, for "Replay in Watch"; null when no frames were recorded. */
  replaySeq: z.int().positive().nullable(),
})
export const AgentHistoryPageSchema = z.object({
  items: z.array(AgentHistoryItemSchema),
  nextCursor: z.string().nullable(),
})
export type AgentChannel = z.infer<typeof AgentChannelSchema>
export type AgentChannelsResponse = z.infer<typeof AgentChannelsResponseSchema>
export type HistoryOutcome = z.infer<typeof HistoryOutcomeSchema>
export type AgentHistoryItem = z.infer<typeof AgentHistoryItemSchema>
export type AgentHistoryPage = z.infer<typeof AgentHistoryPageSchema>

// Contract §8: the agent's Hermes todo list (read-only), shown on Overview and in the Now thread.
export const AgentTodoSchema = z.object({
  id: z.string().max(200),
  content: z.string().max(2000),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  /** Id of the parent item when this one is a subtask. */
  parent: z.string().max(200).optional(),
})
export const AgentTodosSchema = z
  .object({
    todos: z.array(AgentTodoSchema).max(200),
    revision: z.number().int().nonnegative(),
    /** When the list was last written, from the Hermes message that carried it. */
    updatedAt: z.string(),
  })
  .nullable()
export type AgentTodo = z.infer<typeof AgentTodoSchema>
export type AgentTodos = z.infer<typeof AgentTodosSchema>

import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

/**
 * Decision 182: an agent's model for one chat (`/model`, the context bar's "model · effort" tag, Chat info). It wins over
 * the agent's own model in that chat only; the agent's own model, its other chats and its repeating jobs stay as they
 * are. A coding agent picks among its own program's models.
 */

/** A model name as Hermes or a coding CLI takes it: what the pickers list, never a shell word. */
export const ChatModelNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)

export const ChatModelSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  /** What runs: the model id (an alias is resolved when it's chosen). */
  model: ChatModelNameSchema,
  /** Hermes only: the provider paired with the model; null lets Hermes route it. */
  provider: z.string().min(1).max(100).nullable(),
  /** What the person chose, for the tag: the alias (`deep`) or the model itself. */
  label: z.string().min(1).max(200),
})
export type ChatModel = z.infer<typeof ChatModelSchema>

/** `GET /api/rooms/:roomId/models`: the agents set to another model in this chat. An agent not listed uses its own. */
export const ChatModelsResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(ChatModelSchema),
})
export type ChatModelsResponse = z.infer<typeof ChatModelsResponseSchema>

/** `PUT /api/rooms/:roomId/models/:agentId`: a model or alias, or null to go back to the agent's own. */
export const ChatModelRequestSchema = z
  .object({
    model: ChatModelNameSchema.nullable(),
    provider: z.string().min(1).max(100).nullish(),
  })
  .strict()
export type ChatModelRequest = z.infer<typeof ChatModelRequestSchema>

/** The answer to a change: `current` is null when the agent is back to its own; `replaced` is what it had in this chat
 * before this change (for Undo), read in the same write. */
export const ChatModelChangeSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  current: ChatModelSchema.nullable(),
  replaced: ChatModelSchema.nullable(),
})
export type ChatModelChange = z.infer<typeof ChatModelChangeSchema>

/** `GET /api/agents/:agentId/chat-models`: the chats where the agent runs another model than its own. */
export const AgentChatModelsSchema = z.object({
  agentId: AgentIdSchema,
  chats: z.array(
    z.object({
      roomId: z.string().min(1),
      roomName: z.string(),
      roomKind: z.enum(['group', 'direct']),
      jobTitle: z.string().nullable(),
      model: ChatModelNameSchema,
      label: z.string(),
    }),
  ),
})
export type AgentChatModels = z.infer<typeof AgentChatModelsSchema>

/** `model.changed`: an agent's model in a chat changed; `model` null is back to its own. `member`: Score put it back
 * because the agent was taken out of the chat. */
export const ModelChangedSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  model: ChatModelNameSchema.nullable(),
  label: z.string().nullable(),
  reason: z.enum(['person', 'member']),
})
export type ModelChanged = z.infer<typeof ModelChangedSchema>

/** `POST /api/agents/:agentId/routines/pin`: lock the repeating jobs that follow the agent's model onto the model it has
 * now (Hermes `cron edit --pin`), before that model is changed. Answers with the jobs it pinned. */
export const RoutinesPinnedSchema = z.object({ pinned: z.array(z.string().min(1)) })
export type RoutinesPinned = z.infer<typeof RoutinesPinnedSchema>

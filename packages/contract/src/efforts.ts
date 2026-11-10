import { z } from 'zod'
import { AgentIdSchema } from './types.ts'
import { EffortWordSchema } from './coding.ts'

/**
 * Decision 178: an agent's effort for one chat (`/effort`, the context bar, Chat info). It wins over the agent's own
 * setting in that chat only. Score offers a Hermes agent these; a coding agent the levels of its CLI (`CODING_EFFORTS`).
 */
export const CHAT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const ChatEffortSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  effort: EffortWordSchema,
})
export type ChatEffort = z.infer<typeof ChatEffortSchema>

/** `GET /api/rooms/:roomId/efforts`: the agents set differently in this chat. An agent not listed uses its own. */
export const ChatEffortsResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(ChatEffortSchema),
})
export type ChatEffortsResponse = z.infer<typeof ChatEffortsResponseSchema>

/** The answer to a change: null is back to the agent's own. */
export const ChatEffortChangeSchema = ChatEffortSchema.extend({
  effort: EffortWordSchema.nullable(),
})
export type ChatEffortChange = z.infer<typeof ChatEffortChangeSchema>

/** `PUT /api/rooms/:roomId/efforts/:agentId`; null goes back to the agent's own. */
export const ChatEffortRequestSchema = z.object({ effort: EffortWordSchema.nullable() }).strict()
export type ChatEffortRequest = z.infer<typeof ChatEffortRequestSchema>

/** `GET /api/agents/:agentId/efforts`: its own effort, the levels a chat can choose, and where it's set differently. */
export const AgentEffortsSchema = z.object({
  agentId: AgentIdSchema,
  /** Null: the model's own default. */
  own: z.string().nullable(),
  levels: z.array(EffortWordSchema),
  chats: z.array(
    z.object({
      roomId: z.string().min(1),
      roomName: z.string(),
      /** A one-to-one opens as the agent's direct chat; a group as the room. */
      roomKind: z.enum(['group', 'direct']),
      /** The chat's open job, for context. */
      jobTitle: z.string().nullable(),
      effort: EffortWordSchema,
    }),
  ),
})
export type AgentEfforts = z.infer<typeof AgentEffortsSchema>

/** `effort.changed`: an agent's effort in a chat changed; null is back to its own. `reason: model`: Score put it back
 * because the agent's levels no longer include it. */
export const EffortChangedSchema = z.object({
  roomId: z.string().min(1),
  agentId: AgentIdSchema,
  effort: EffortWordSchema.nullable(),
  reason: z.enum(['person', 'model']),
})
export type EffortChanged = z.infer<typeof EffortChangedSchema>

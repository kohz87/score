import { z } from 'zod'
import { JobSubagentsRequestSchema } from './subagents.ts'

/**
 * 3.23.0 (chats stage 3): a run started from a chat becomes a topic of that chat in the same server call. The run and
 * its topic are created in one transaction: either both exist or neither does (before, the job was a second call).
 */
export const RunTopicRequestSchema = z
  .object({
    /** The chat (a room that routes with exchanges: a team or group chat). */
    roomId: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    /** The topic's limits, as on `POST /api/rooms/:roomId/jobs`; omitted = the defaults. */
    exchangeBudget: z.int().min(1).max(100).optional(),
    jobTurnLimit: z.int().min(1).max(1000).optional(),
    spendCapUsd: z.number().positive().max(10_000).optional(),
    subagents: JobSubagentsRequestSchema.optional(),
  })
  .strict()
export type RunTopicRequest = z.infer<typeof RunTopicRequestSchema>

import {
  AgentIdSchema,
  AutoSummarySchema,
  MessageAttachmentSchema,
  RoomTagSchema,
  TeamRoomCreateRequestSchema,
} from '@score/contract'
import { z } from 'zod'
import { MAX_ATTACHMENTS } from '../../media/store.ts'

// "#launch" or "launch", optionally followed by #tag words ("#launch #q4"): tags are parsed from the name (PLAN 5.26).
export const NameSchema = z
  .string()
  .regex(/^#?[a-z0-9][a-z0-9-]{0,63}( #[a-z0-9][a-z0-9-]{0,31}){0,8}$/)
  .transform((name) => (name.startsWith('#') ? name : `#${name}`))
export const CreateSchema = z
  .object({
    name: NameSchema,
    leadAgentId: AgentIdSchema.optional(),
    members: z.array(AgentIdSchema).optional(),
  })
  .strict()
// Team rooms carry plain names ("Team room", "Docs team"); other rooms keep `#slug` names (decision 136).
export const TeamNameSchema = TeamRoomCreateRequestSchema.shape.name
export const PatchSchema = z
  .object({
    ...CreateSchema.partial().shape,
    name: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(),
    /** null = follow the `#tags` in the name again. */
    tags: z.array(RoomTagSchema).max(12).nullable().optional(),
    autoSummary: AutoSummarySchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0)
export const MessageBodySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(16384)
      .refine((text) => Buffer.byteLength(text, 'utf8') <= 16384),
    to: z.array(AgentIdSchema).optional(),
    planFirst: z.boolean().optional(),
    model: z.string().min(1).max(256).optional(),
    attachments: z.array(MessageAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
    edits: z.string().min(1).max(200).optional(),
    jobId: z.string().min(1).max(64).optional(),
    /** PLAN 11.2: jobs this message refers to; each is frozen into a `ref` part when it is sent. */
    refs: z
      .array(z.object({ jobId: z.string().min(1).max(64) }).strict())
      .max(5)
      .optional(),
  })
  .strict()
export const ParamsSchema = z.object({ roomId: z.string().min(1).max(256) })
export const QuerySchema = z
  .object({
    before: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    jobId: z.string().min(1).max(64).optional(),
    /** 3.22.0: `all=1` reads every non-deleted job of the room in one ordered, paged read (not with `jobId`). */
    all: z.enum(['1']).optional(),
  })
  .strict()
  .refine((query) => query.all === undefined || query.jobId === undefined, {
    message: 'all and jobId can’t be combined',
  })

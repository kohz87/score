import { z } from 'zod'
// Local copy: types.ts imports this file, so importing it back would be circular.
const AgentIdSchema = z.string().min(1)

// §5 Chat: organise rooms, search, share links, outside sessions (PLAN 5.26).

export const RoomTagSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
export const ProjectColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const RoomProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  color: ProjectColorSchema,
})
export type RoomProject = z.infer<typeof RoomProjectSchema>

export const RoomProjectBodySchema = z
  .object({ name: z.string().trim().min(1).max(64), color: ProjectColorSchema })
  .strict()

export const RoomProjectEventSchema = z.object({ id: z.string().min(1) })

/** Where a room's history came from when it was imported from a Hermes session Score did not start. */
export const RoomImportSchema = z.object({
  agentId: AgentIdSchema,
  sessionId: z.string().min(1),
  /** Hermes' platform id: telegram, cli, discord, … */
  source: z.string().min(1),
  /** "Telegram", "CLI", … */
  label: z.string().min(1),
  /** How new turns from the room reach Hermes; null until "Continue here" was used. */
  continued: z.enum(['same_session', 'new_session']).nullable(),
})
export type RoomImport = z.infer<typeof RoomImportSchema>

export const MessageSearchHitSchema = z.object({
  messageId: z.string().min(1),
  roomId: z.string().min(1),
  roomName: z.string(),
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('you') }),
    z.object({ kind: z.literal('agent'), agentId: AgentIdSchema }),
  ]),
  createdAt: z.iso.datetime(),
  /** Redacted; `[[` and `]]` mark matches. */
  snippet: z.string(),
})
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>
export const MessageSearchResponseSchema = z.object({ items: z.array(MessageSearchHitSchema) })

export const ShareCreateRequestSchema = z
  .object({
    password: z.unknown().optional(),
    expiresInDays: z.int().min(1).max(30).default(7),
    includeImages: z.boolean().default(false),
  })
  .strict()
export const ShareCreatedSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.iso.datetime(),
})
export type ShareCreated = z.infer<typeof ShareCreatedSchema>

export const ShareSummarySchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  roomName: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  views: z.int().nonnegative(),
  includeImages: z.boolean(),
  status: z.enum(['active', 'expired']),
  /** A message of the room was deleted, edited or rewound after the snapshot was taken (the link still shows it). */
  roomChanged: z.boolean(),
})
export type ShareSummary = z.infer<typeof ShareSummarySchema>
export const SharesResponseSchema = z.object({ items: z.array(ShareSummarySchema) })

export const OutsideSessionSchema = z.object({
  id: z.string().min(1),
  agentId: AgentIdSchema,
  /** Hermes' platform id: telegram, cli, discord, … */
  source: z.string().min(1),
  sourceLabel: z.string().min(1),
  /** The session title, else its first user message (redacted, cut); "" when neither exists. */
  title: z.string(),
  startedAt: z.iso.datetime(),
  messageCount: z.int().nonnegative(),
  /** Still active on its platform (recent activity, not ended): Continue here is refused. */
  busy: z.boolean(),
  /** The Score room made from it, when imported. */
  roomId: z.string().min(1).nullable(),
})
export type OutsideSession = z.infer<typeof OutsideSessionSchema>
export const OutsideSessionsResponseSchema = z.object({
  items: z.array(OutsideSessionSchema),
  /** Profiles that could not be read (missing database, schema drift). */
  unavailable: z.array(AgentIdSchema),
})
export const ImportSessionRequestSchema = z
  .object({ agentId: AgentIdSchema, sessionId: z.string().min(1).max(256) })
  .strict()
export const ImportSessionResponseSchema = z.object({
  roomId: z.string().min(1),
  imported: z.int().nonnegative(),
})
export const ContinueSessionResponseSchema = z.object({
  mode: z.enum(['same_session', 'new_session']),
})

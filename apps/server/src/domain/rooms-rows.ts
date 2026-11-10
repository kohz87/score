import type { DatabaseSync } from 'node:sqlite'
import {
  AgentIdSchema,
  RoomImportSchema,
  RoomSchema,
  RoomTagSchema,
  type Room,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'

export const RoomRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: RoomSchema.shape.kind,
  lead_agent_id: AgentIdSchema.nullable(),
  members: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  version: z.int().positive(),
  pinned: z.union([z.literal(0), z.literal(1)]),
  archived: z.union([z.literal(0), z.literal(1)]),
  project_id: z.string().nullable(),
  workspace_id: z.string().nullable().default(null),
  tags: z.string().nullable(),
  imported_from: z.string().nullable(),
  auto_summary: z.string().nullable(),
  active_agents: z.string().default('[]'),
  role: z.enum(['team', 'direct', 'room']).default('room'),
  team_everyone: z.number().int().default(0),
  routing: z.enum(['mentions', 'exchanges']).default('exchanges'),
})
export const MessageRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  author_kind: z.enum(['you', 'agent']),
  author_agent_id: AgentIdSchema.nullable(),
  to: z.string(),
  parts: z.string(),
  refs: z.string(),
  streaming: z.union([z.literal(0), z.literal(1)]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  version: z.int().positive(),
  edited_by: z.string().nullish(),
  edits: z.string().nullish(),
  deleted_at: z.string().nullish(),
  progress_at: z.string().nullish(),
  job_id: z.string().nullish(),
  alternative_of: z.string().nullish(),
  effort: z.string().nullish(),
  model: z.string().nullish(),
  reply_kind: z.enum(['person', 'handoff']).nullish(),
  speed: z.string().nullish(),
})

/** `#tag` words after the first word of a room's name ("#launch #q4 #urgent"), lower-case and valid only. */
export function nameTags(name: string): string[] {
  const tags = name
    .split(/\s+/)
    .slice(1)
    .flatMap((word) => (word.startsWith('#') ? [word.slice(1).toLowerCase()] : []))
    .filter((tag) => RoomTagSchema.safeParse(tag).success)
  return [...new Set(tags)]
}

export function importedFrom(
  sqlite: DatabaseSync,
  row: z.infer<typeof RoomRowSchema>,
): Room['importedFrom'] {
  if (row.imported_from === null) return null
  const base = z
    .object({
      agentId: AgentIdSchema,
      sessionId: z.string(),
      source: z.string(),
      label: z.string(),
    })
    .parse(JSON.parse(row.imported_from))
  const mode = sqlite
    .prepare('SELECT mode FROM room_sessions WHERE room_id = ? AND agent_id = ?')
    .get(row.id, base.agentId)
  return RoomImportSchema.parse({
    ...base,
    continued: z.object({ mode: z.string() }).nullish().parse(mode)?.mode ?? null,
  })
}

export function roomRow(sqlite: DatabaseSync, id: string) {
  const row = sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  return RoomRowSchema.parse(row)
}

export type RoomRow = z.infer<typeof RoomRowSchema>

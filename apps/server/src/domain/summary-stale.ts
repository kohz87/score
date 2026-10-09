import type { DatabaseSync } from 'node:sqlite'
import { MessagePartSchema, type MessagePart } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'

// Kept free of imports from rooms.ts so that rooms.ts and versions.ts can call it (PLAN 7.4a).

const PartsSchema = z
  .string()
  .transform((value) => z.array(MessagePartSchema).parse(JSON.parse(value)))

export type SummaryPart = Extract<MessagePart, { kind: 'summary' }>

/** Summary messages of a room that are still visible, newest first. */
export function visibleSummaries(
  sqlite: DatabaseSync,
  roomId: string,
): {
  id: string
  createdAt: string
  updatedAt: string
  authorAgentId: string | null
  part: SummaryPart
}[] {
  const rows = sqlite
    .prepare(
      `SELECT id, created_at, updated_at, author_agent_id, parts FROM messages
       WHERE room_id = ? AND deleted_at IS NULL AND streaming = 0
         AND EXISTS (SELECT 1 FROM json_each(messages.parts) WHERE json_extract(value, '$.kind') = 'summary')
       ORDER BY created_at DESC, id DESC`,
    )
    .all(roomId)
  return z
    .array(
      z.object({
        id: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        author_agent_id: z.string().nullable(),
        parts: PartsSchema,
      }),
    )
    .parse(rows)
    .flatMap((row) => {
      const part = row.parts.find((item) => item.kind === 'summary')
      return part
        ? [
            {
              id: row.id,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              authorAgentId: row.author_agent_id,
              part,
            },
          ]
        : []
    })
}

/**
 * A summary is stale once a message it covers was hidden (deleted, edited or rewound) after the summary was written:
 * its text may still carry what the person took back.
 */
export function coveredMessageHidden(
  sqlite: DatabaseSync,
  roomId: string,
  summary: { createdAt: string; updatedAt: string; part: SummaryPart },
): boolean {
  const boundary = sqlite
    .prepare('SELECT created_at, id, deleted_at FROM messages WHERE id = ? AND room_id = ?')
    .get(summary.part.coversUntil, roomId) as
    { created_at: string; id: string; deleted_at: string | null } | undefined
  if (!boundary) return true
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM messages WHERE room_id = ? AND (created_at, id) <= (?, ?)
           AND deleted_at IS NOT NULL AND deleted_at > ?
           AND NOT EXISTS (SELECT 1 FROM json_each(messages.parts) WHERE json_extract(value, '$.kind') = 'summary') LIMIT 1`,
      )
      // An edited summary was read and vouched for by the person at its last update.
      .get(
        roomId,
        boundary.created_at,
        boundary.id,
        summary.part.edited ? summary.updatedAt : summary.createdAt,
      ),
  )
}

/** Marks every visible summary whose covered messages were hidden as stale; call after anything that hides messages. */
export function markStaleSummaries(
  sqlite: DatabaseSync,
  roomId: string,
  now: string,
): DomainEventDraft[] {
  const drafts: DomainEventDraft[] = []
  for (const summary of visibleSummaries(sqlite, roomId)) {
    if (summary.part.stale || !coveredMessageHidden(sqlite, roomId, summary)) continue
    const parts = PartsSchema.parse(
      (
        sqlite.prepare('SELECT parts FROM messages WHERE id = ?').get(summary.id) as {
          parts: string
        }
      ).parts,
    ).map((part) => (part.kind === 'summary' ? { ...part, stale: true } : part))
    sqlite
      .prepare('UPDATE messages SET parts = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(JSON.stringify(parts), now, summary.id)
    drafts.push({ type: 'message.updated', data: { roomId, messageId: summary.id, parts } })
  }
  return drafts
}

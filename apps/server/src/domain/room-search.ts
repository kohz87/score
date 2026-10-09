import type { DatabaseSync } from 'node:sqlite'
import { MessageSearchHitSchema, type MessageSearchHit } from '@score/contract'
import { z } from 'zod'
import { redact } from '../redact.ts'

const RowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  room_name: z.string(),
  author_kind: z.enum(['you', 'agent']),
  author_agent_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  snippet: z.string(),
})

/**
 * Full-text search over the text parts of finished, undeleted messages (migration 0033 keeps `message_fts` current).
 * As in Knowledge, user text is never FTS syntax: only words survive, each quoted; the last word matches as a prefix.
 */
export function searchMessages(
  sqlite: DatabaseSync,
  query: string,
  limit: number,
  roomId?: string,
): MessageSearchHit[] {
  const words = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12)
  if (words.length === 0) return []
  const match = words
    .map((word, index) => `"${word}"${index === words.length - 1 ? '*' : ''}`)
    .join(' ')
  try {
    return z
      .array(RowSchema)
      .parse(
        sqlite
          .prepare(
            `SELECT m.id, m.room_id, r.name AS room_name, m.author_kind, m.author_agent_id, m.created_at,
               snippet(message_fts, 0, '[[', ']]', '…', 16) AS snippet
             FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid JOIN rooms r ON r.id = m.room_id
             WHERE message_fts MATCH ? AND m.deleted_at IS NULL AND (? IS NULL OR m.room_id = ?)
             ORDER BY bm25(message_fts), m.created_at DESC LIMIT ?`,
          )
          .all(match, roomId ?? null, roomId ?? null, Math.min(Math.max(limit, 1), 50)),
      )
      .map((row) =>
        MessageSearchHitSchema.parse({
          messageId: row.id,
          roomId: row.room_id,
          roomName: row.room_name,
          author:
            row.author_kind === 'you'
              ? { kind: 'you' }
              : { kind: 'agent', agentId: row.author_agent_id },
          createdAt: row.created_at,
          snippet: redact(row.snippet),
        }),
      )
  } catch {
    return []
  }
}

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { RoomImportSchema } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import type { OutsideSessionHistory } from '../hermes/outside-sessions.ts'
import { redact } from '../redact.ts'
import { insertRoom, readRoom, roomChanged, roomRow } from './rooms.ts'

/** Imported copies are marked by their id prefix; the web shows them as "from Telegram" and offers no edit or retry. */
export const IMPORTED_ID_PREFIX = 'import:'

const ImportedFromSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  source: z.string(),
  label: z.string(),
})

/** Rooms already made from outside sessions, by `agentId\0sessionId`. */
export function importedRooms(sqlite: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>()
  const rows = z
    .array(z.object({ id: z.string(), imported_from: z.string() }))
    .parse(
      sqlite.prepare('SELECT id, imported_from FROM rooms WHERE imported_from IS NOT NULL').all(),
    )
  for (const row of rows) {
    const from = ImportedFromSchema.safeParse(JSON.parse(row.imported_from))
    if (from.success) map.set(`${from.data.agentId}\0${from.data.sessionId}`, row.id)
  }
  return map
}

function roomName(sqlite: DatabaseSync, history: OutsideSessionHistory): string {
  const { session } = history
  const slug = (session.title || session.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '')
  const source = session.source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = `#${[source || 'session', slug].filter(Boolean).join('-')}`.slice(0, 50)
  const tags = ` #imported${source ? ` #${source.slice(0, 31)}` : ''}`
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const name = `${base}${suffix}${tags}`
    if (!sqlite.prepare('SELECT 1 FROM rooms WHERE name = ?').get(name)) return name
  }
}

/**
 * Creates a Score room holding read-only copies of an outside session's messages (redacted, original times). An
 * already imported session returns its existing room. Nothing is written to Hermes.
 */
export function importOutsideSession(
  sqlite: DatabaseSync,
  history: OutsideSessionHistory,
  now: string,
): { roomId: string; imported: number; events: DomainEventDraft[] } {
  const { session } = history
  const existing = importedRooms(sqlite).get(`${session.agentId}\0${session.id}`)
  if (existing) return { roomId: existing, imported: 0, events: [] }
  const roomId = randomUUID()
  insertRoom(
    sqlite,
    {
      id: roomId,
      name: roomName(sqlite, history),
      kind: 'room',
      leadAgentId: session.agentId,
      members: [session.agentId],
      importedFrom: {
        agentId: session.agentId,
        sessionId: session.id,
        source: session.source,
        label: session.sourceLabel,
      },
    },
    now,
  )
  const insert = sqlite.prepare(
    `INSERT INTO messages (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, '[]', 0, ?, ?)`,
  )
  let last: { id: string; at: string } | undefined
  history.messages.forEach((message, index) => {
    const id = `${IMPORTED_ID_PREFIX}${roomId}:${index}`
    insert.run(
      id,
      roomId,
      message.role === 'user' ? 'you' : 'agent',
      message.role === 'user' ? null : session.agentId,
      JSON.stringify([{ kind: 'text', text: redact(message.text) }]),
      message.at,
      now,
    )
    last = { id, at: message.at }
  })
  // The history is something the person already saw elsewhere: it must not show up as unread.
  if (last)
    sqlite
      .prepare(
        'INSERT INTO room_reads (room_id, last_read_message_created_at, last_read_message_id) VALUES (?, ?, ?)',
      )
      .run(roomId, last.at, last.id)
  return {
    roomId,
    imported: history.messages.length,
    events: roomChanged(sqlite, roomId, now),
  }
}

const SUMMARY_CHARS = 2000
const SNIPPET = 280
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET - 1)}…` : flat
}

/** A short plain-text recap of the imported messages, for a new Hermes session that cannot load the old one. */
export function sessionSummary(sqlite: DatabaseSync, roomId: string, label: string): string {
  const rows = z.array(z.object({ author_kind: z.string(), parts: z.string() })).parse(
    sqlite
      .prepare(
        `SELECT author_kind, parts FROM messages WHERE room_id = ? AND id LIKE ? AND deleted_at IS NULL
           ORDER BY created_at, id`,
      )
      .all(roomId, `${IMPORTED_ID_PREFIX}%`),
  )
  const lines = rows.map((row) => {
    const text = (JSON.parse(row.parts) as { kind: string; text?: string }[])
      .flatMap((part) => (part.kind === 'text' && part.text ? [part.text] : []))
      .join(' ')
    return `${row.author_kind === 'you' ? 'You' : 'Assistant'}: ${oneLine(text)}`
  })
  const picked = lines.length > 8 ? [...lines.slice(0, 2), '…', ...lines.slice(-6)] : lines
  const body = picked.join('\n')
  return redact(
    `Earlier conversation (imported from ${label}, ${rows.length} messages), shortened:\n${body.slice(0, SUMMARY_CHARS)}`,
  )
}

export type ContinueMode = 'same_session' | 'new_session'

/** Records how new turns of an imported room reach Hermes. Throws 404 when the room was not imported. */
export function setContinuation(
  sqlite: DatabaseSync,
  roomId: string,
  mode: ContinueMode,
  summary: string | null,
  now: string,
): DomainEventDraft[] {
  const row = roomRow(sqlite, roomId)
  if (!row.imported_from) throw new HttpError(409, 'conflict', 'This room was not imported')
  const from = RoomImportSchema.pick({ agentId: true, sessionId: true }).parse(
    JSON.parse(row.imported_from),
  )
  const before = readRoom(sqlite, roomId, row.updated_at)
  sqlite
    .prepare(
      `INSERT INTO room_sessions (room_id, agent_id, session_id, mode, summary, summary_sent)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET
         session_id = excluded.session_id, mode = excluded.mode, summary = excluded.summary,
         summary_sent = CASE WHEN room_sessions.mode = excluded.mode THEN room_sessions.summary_sent ELSE 0 END`,
    )
    .run(roomId, from.agentId, from.sessionId, mode, summary)
  return roomChanged(sqlite, roomId, now, before)
}

/** What the next turn of `agentId` in this room needs: the Hermes session to run in and a one-time summary. */
export function continuationFor(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
): { sessionId: string | null; summary: string | null; summaryTurn: boolean } {
  const row = z
    .object({
      session_id: z.string(),
      mode: z.enum(['same_session', 'new_session']),
      summary: z.string().nullable(),
      summary_sent: z.union([z.literal(0), z.literal(1)]),
    })
    .nullish()
    .parse(
      sqlite
        .prepare(
          'SELECT session_id, mode, summary, summary_sent FROM room_sessions WHERE room_id = ? AND agent_id = ?',
        )
        .get(roomId, agentId),
    )
  if (!row) return { sessionId: null, summary: null, summaryTurn: false }
  if (row.mode === 'same_session')
    return { sessionId: row.session_id, summary: null, summaryTurn: false }
  return {
    sessionId: null,
    summary: row.summary_sent === 0 ? row.summary : null,
    summaryTurn: row.summary_sent === 0 && row.summary !== null,
  }
}

export function markSummarySent(sqlite: DatabaseSync, roomId: string, agentId: string): void {
  sqlite
    .prepare('UPDATE room_sessions SET summary_sent = 1 WHERE room_id = ? AND agent_id = ?')
    .run(roomId, agentId)
}

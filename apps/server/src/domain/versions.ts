import type { DatabaseSync } from 'node:sqlite'
import {
  AgentIdSchema,
  RoomVersionSchema,
  type Message,
  type RewindMode,
  type RewoundAgent,
  type RoomVersion,
  type SkippedAgent,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { IMPORTED_ID_PREFIX } from './outside-sessions.ts'
import { MessageRowSchema, messageFromRow, readRoom, roomChanged, roomRow } from './rooms.ts'

const VersionRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  anchor_id: z.string(),
  mode: z.enum(['edit', 'delete']),
  score_only: z.union([z.literal(0), z.literal(1)]),
  hidden_count: z.int().nonnegative(),
  rewound: z.string(),
  skipped: z.string(),
  replaced_by: z.string().nullable(),
  created_at: z.iso.datetime(),
  anchor_created_at: z.iso.datetime(),
})
type VersionRow = z.infer<typeof VersionRowSchema>

const SELECT = `SELECT v.*, a.created_at AS anchor_created_at FROM room_versions v JOIN messages a ON a.id = v.anchor_id`

/** Versions of one chain of edits: a correction that was edited again continues the chain of its original. */
function toVersions(rows: VersionRow[]): RoomVersion[] {
  const byAnchor = new Map(rows.map((row) => [row.anchor_id, row]))
  const byReplacement = new Map(
    rows.flatMap((row) => (row.replaced_by ? [[row.replaced_by, row] as const] : [])),
  )
  return rows.map((row) => {
    let before = 0
    for (
      let at = byReplacement.get(row.anchor_id);
      at && before < 1000;
      at = byReplacement.get(at.anchor_id)
    )
      before++
    let after = 0
    for (
      let at = row.replaced_by ? byAnchor.get(row.replaced_by) : undefined;
      at && after < 1000;
      at = at.replaced_by ? byAnchor.get(at.replaced_by) : undefined
    )
      after++
    // An edit chain ends in the live correction ("Version 2 of 2"); a delete has no live version after it.
    const live = chainEndsInDelete(row, byAnchor) ? 0 : 1
    return RoomVersionSchema.parse({
      id: row.id,
      roomId: row.room_id,
      anchorId: row.anchor_id,
      anchorCreatedAt: row.anchor_created_at,
      mode: row.mode,
      replacedBy: row.replaced_by,
      number: before + 1,
      count: before + 1 + after + live,
      hiddenCount: row.hidden_count,
      rewound: JSON.parse(row.rewound) as unknown,
      skipped: JSON.parse(row.skipped) as unknown,
      createdAt: row.created_at,
    })
  })
}
function chainEndsInDelete(row: VersionRow, byAnchor: Map<string, VersionRow>): boolean {
  let at = row
  for (let hops = 0; hops < 1000; hops++) {
    if (at.mode === 'delete') return true
    const next = at.replaced_by ? byAnchor.get(at.replaced_by) : undefined
    if (!next) return false
    at = next
  }
  return false
}

export function listVersions(sqlite: DatabaseSync, roomId: string): RoomVersion[] {
  roomRow(sqlite, roomId)
  const rows = z
    .array(VersionRowSchema)
    .parse(sqlite.prepare(`${SELECT} WHERE v.room_id = ? ORDER BY v.created_at, v.id`).all(roomId))
  return toVersions(rows).reverse()
}

export function versionOfAnchor(
  sqlite: DatabaseSync,
  roomId: string,
  anchorId: string,
): RoomVersion | null {
  return listVersions(sqlite, roomId).find((version) => version.anchorId === anchorId) ?? null
}

/** The hidden messages of a version, anchor first, oldest to newest. */
export function versionMessages(sqlite: DatabaseSync, versionId: string): Message[] {
  return sqlite
    .prepare('SELECT * FROM messages WHERE version_id = ? ORDER BY created_at, id')
    .all(versionId)
    .map(messageFromRow)
}

/** The person's own, finished, visible message in this room: the only kind that can be rewound. */
export function rewindableMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
): Message {
  roomRow(sqlite, roomId)
  const value = sqlite
    .prepare('SELECT * FROM messages WHERE id = ? AND room_id = ? AND deleted_at IS NULL')
    .get(messageId, roomId)
  if (!value) throw new HttpError(404, 'not_found', 'Unknown message')
  assertNotImported(messageId)
  const message = messageFromRow(value)
  if (message.author.kind !== 'you' || message.streaming)
    throw new HttpError(400, 'bad_request', 'Only your own finished message can be rewound')
  if (message.editedBy) throw new HttpError(409, 'conflict', 'This message was already edited')
  return message
}

/** Copies of messages from outside sessions are a record of what happened elsewhere: never corrected or rewound here. */
function assertNotImported(messageId: string): void {
  if (messageId.startsWith(IMPORTED_ID_PREFIX))
    throw new HttpError(400, 'bad_request', 'An imported message cannot be edited or rewound')
}

export interface RewindTurns {
  agentId: string
  turns: number
  sessionId: string
}

export interface RewindScope {
  hiddenCount: number
  /** Why a rewind can't start now; null when it can. */
  blocked: string | null
  agents: RewindTurns[]
}

const AFTER = '(created_at, id) >= (?, ?)'

/** What a rewind of `anchor` hides and how many Hermes turns each agent has from there, by Score's own records. */
export function rewindScope(sqlite: DatabaseSync, roomId: string, anchor: Message): RewindScope {
  const hidden = z.object({ count: z.int(), streaming: z.int() }).parse(
    sqlite
      .prepare(
        `SELECT count(*) AS count, COALESCE(SUM(streaming), 0) AS streaming FROM messages
           WHERE room_id = ? AND deleted_at IS NULL AND ${AFTER}`,
      )
      .get(roomId, anchor.createdAt, anchor.id),
  )
  const open = z.object({ count: z.int(), held: z.int() }).parse(
    sqlite
      .prepare(
        `SELECT count(*) AS count,
             COALESCE(SUM(EXISTS (SELECT 1 FROM team_state WHERE paused_at IS NOT NULL)
               OR EXISTS (SELECT 1 FROM briefs b WHERE b.id = mr.chain_id AND b.paused_at IS NOT NULL)), 0) AS held
           FROM message_runs mr WHERE mr.room_id = ? AND mr.state IN ('pending', 'active')`,
      )
      .get(roomId),
  )
  let blocked: string | null = null
  if (open.held > 0)
    blocked = "The room's work is paused with queued turns; resume it or stop them first"
  else if (hidden.streaming > 0 || open.count > 0)
    blocked = 'An agent is still answering or has queued work in this room; stop it first'
  // A run counts from the moment its reply started (a retry or a queued turn can start after its message).
  const rows = z.array(z.object({ agent_id: AgentIdSchema, turns: z.int().positive() })).parse(
    sqlite
      .prepare(
        `SELECT mr.agent_id, count(*) AS turns FROM message_runs mr
           LEFT JOIN messages m ON m.id = mr.message_id
           WHERE mr.room_id = ? AND mr.rewound_at IS NULL AND mr.state IN ('completed', 'failed') AND mr.run_id IS NOT NULL
             AND COALESCE(m.created_at, mr.created_at) >= ?
           GROUP BY mr.agent_id ORDER BY mr.agent_id`,
      )
      .all(roomId, anchor.createdAt),
  )
  return {
    hiddenCount: hidden.count,
    blocked,
    agents: rows.map((row) => ({
      agentId: row.agent_id,
      turns: row.turns,
      sessionId: `score-${roomId}-${row.agent_id}`,
    })),
  }
}

/** Remembered once an agent's Hermes session was rewound past these turns, so no later rewind counts them again. */
export function markRunsRewound(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
  since: string,
  now: string,
): void {
  sqlite
    .prepare(
      `UPDATE message_runs SET rewound_at = ? WHERE room_id = ? AND agent_id = ? AND rewound_at IS NULL AND state IN ('completed', 'failed') AND run_id IS NOT NULL
         AND COALESCE((SELECT created_at FROM messages WHERE id = message_runs.message_id), created_at) >= ?`,
    )
    .run(now, roomId, agentId, since)
}

/**
 * Hides `anchor` and every visible message after it as a previous version of the room. Runs in the caller's
 * transaction after every needed rewind succeeded (or the person chose to hide in Score only).
 */
export function createVersion(
  sqlite: DatabaseSync,
  req: {
    roomId: string
    anchor: Message
    mode: RewindMode
    scoreOnly: boolean
    rewound: RewoundAgent[]
    skipped: SkippedAgent[]
    /** A message stored in the same transaction (the edit's correction) that must stay visible. */
    except?: string
  },
  now: string,
): { version: RoomVersion; drafts: DomainEventDraft[] } {
  const { roomId, anchor } = req
  const existing = versionOfAnchor(sqlite, roomId, anchor.id)
  if (existing) return { version: existing, drafts: [] }
  const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
  const ids = z
    .array(z.object({ id: z.string() }))
    .parse(
      sqlite
        .prepare(
          `SELECT id FROM messages WHERE room_id = ? AND deleted_at IS NULL AND ${AFTER} AND id != ? ORDER BY created_at, id`,
        )
        .all(roomId, anchor.createdAt, anchor.id, req.except ?? ''),
    )
    .map((row) => row.id)
  const id = randomUUID()
  sqlite
    .prepare(
      `INSERT INTO room_versions (id, room_id, anchor_id, mode, score_only, hidden_count, rewound, skipped, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      anchor.id,
      req.mode,
      Number(req.scoreOnly),
      ids.length,
      JSON.stringify(req.rewound),
      JSON.stringify(req.skipped),
      now,
    )
  const hide = sqlite.prepare(
    'UPDATE messages SET deleted_at = ?, version_id = ?, updated_at = ?, version = version + 1 WHERE id = ?',
  )
  for (const messageId of ids) hide.run(now, id, now, messageId)
  const version = versionOfAnchor(sqlite, roomId, anchor.id)!
  return {
    version,
    drafts: [
      ...ids.map((messageId) => ({
        type: 'message.deleted' as const,
        data: { roomId, messageId },
      })),
      ...roomChanged(sqlite, roomId, now, before),
      { type: 'room.version.created' as const, data: version },
    ],
  }
}

/** A message hidden by an edit's rewind that has no correction yet (null otherwise). */
export function openEditVersion(
  sqlite: DatabaseSync,
  roomId: string,
  anchorId: string,
): string | null {
  const row = sqlite
    .prepare(
      `SELECT id FROM room_versions WHERE room_id = ? AND anchor_id = ? AND mode = 'edit' AND replaced_by IS NULL`,
    )
    .get(roomId, anchorId) as { id: string } | undefined
  return row?.id ?? null
}

/** The correction is posted: link it to the version and mark the original as edited. */
export function linkCorrection(
  sqlite: DatabaseSync,
  roomId: string,
  anchorId: string,
  correctionId: string,
  now: string,
): DomainEventDraft[] {
  sqlite
    .prepare('UPDATE room_versions SET replaced_by = ? WHERE anchor_id = ? AND replaced_by IS NULL')
    .run(correctionId, anchorId)
  sqlite
    .prepare(
      'UPDATE messages SET edited_by = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run(correctionId, now, anchorId)
  const version = versionOfAnchor(sqlite, roomId, anchorId)!
  return [
    { type: 'message.updated', data: { roomId, messageId: anchorId, editedBy: correctionId } },
    { type: 'room.version.created', data: version },
  ]
}

/**
 * The message a person is correcting (PLAN 5.24): their own, in this room, finished, not corrected before, and either
 * visible or hidden by the edit's own rewind and still waiting for its correction (PLAN 5.33). Throws the HTTP error the
 * contract names.
 */
export function editableMessage(sqlite: DatabaseSync, roomId: string, messageId: string): Message {
  const value = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  if (!value) throw new HttpError(404, 'not_found', 'Unknown message')
  const row = MessageRowSchema.parse(value)
  assertNotImported(messageId)
  const rewound = row.room_id === roomId && openEditVersion(sqlite, roomId, messageId) !== null
  if (row.deleted_at && !rewound) throw new HttpError(404, 'not_found', 'Unknown message')
  if (row.room_id !== roomId || row.author_kind !== 'you' || row.streaming === 1)
    throw new HttpError(
      400,
      'bad_request',
      'Only your own finished message in this room can be edited',
    )
  if (row.edited_by) throw new HttpError(409, 'conflict', 'This message was already edited')
  if (!rewound) {
    // Without a rewind the edit hides the original and everything after it in Score only: nothing may be running.
    const answering = sqlite
      .prepare(
        `SELECT 1 FROM message_runs r JOIN messages m ON m.id = r.message_id
         WHERE (r.parent_message_id = ? OR r.chain_id = ?) AND m.deleted_at IS NULL AND m.streaming = 1`,
      )
      .get(messageId, messageId)
    if (answering)
      throw new HttpError(
        409,
        'conflict',
        'An agent is still answering this message; stop it first',
      )
    const scope = rewindScope(sqlite, roomId, messageFromRow(value))
    if (scope.blocked) throw new HttpError(409, 'conflict', scope.blocked)
  }
  return messageFromRow(value)
}

/**
 * The correction was stored by the caller. A message the edit already rewound is just linked; otherwise it is hidden
 * now, with everything after it, as a previous version in Score only (the agents' Hermes histories keep their turns).
 */
export function markEdited(
  sqlite: DatabaseSync,
  roomId: string,
  original: Message,
  editedBy: string,
  now: string,
): DomainEventDraft[] {
  const drafts: DomainEventDraft[] = []
  if (!openEditVersion(sqlite, roomId, original.id)) {
    const scope = rewindScope(sqlite, roomId, original)
    drafts.push(
      ...createVersion(
        sqlite,
        {
          roomId,
          anchor: original,
          mode: 'edit',
          scoreOnly: true,
          except: editedBy,
          rewound: [],
          skipped: scope.agents.map((agent) => ({
            agentId: agent.agentId,
            reason: 'score_only' as const,
          })),
        },
        now,
      ).drafts,
    )
  }
  return [...drafts, ...linkCorrection(sqlite, roomId, original.id, editedBy, now)]
}

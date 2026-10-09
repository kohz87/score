import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ShareSummarySchema, type ShareSummary } from '@score/contract'
import { z } from 'zod'
import { redact } from '../redact.ts'
import type { ShareSnapshot } from '../shares/page.ts'
import { messageFromRow, roomRow } from './rooms.ts'

const MAX_MESSAGES = 2000
const DAY_MS = 24 * 60 * 60 * 1000
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export function newShareToken(): string {
  return randomBytes(32).toString('base64url')
}
/** Only this hash is stored: a leaked database does not leak working links. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
export function wellFormedToken(token: string): boolean {
  return TOKEN.test(token)
}

/**
 * The frozen content of a share (PLAN 5.26): the room's finished, undeleted messages reduced to author name, time and
 * redacted text. Tool, thinking, file, plan, review and approval parts never get in; image media ids only when asked.
 * No room settings, member ids, workspace paths or profile data.
 */
export function buildShareSnapshot(
  sqlite: DatabaseSync,
  roomId: string,
  names: ReadonlyMap<string, string>,
  includeImages: boolean,
): ShareSnapshot {
  const room = roomRow(sqlite, roomId)
  const images: string[] = []
  const rows = sqlite
    .prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND streaming = 0
         ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at, id`,
    )
    .all(roomId, MAX_MESSAGES)
  const messages = rows
    .map(messageFromRow)
    .map((message) => {
      const text = message.parts
        .flatMap((part) => (part.kind === 'text' ? [redact(part.text)] : []))
        .join('\n\n')
      const own: number[] = []
      if (includeImages)
        for (const part of message.parts) {
          if (part.kind !== 'image') continue
          let at = images.indexOf(part.mediaId)
          if (at < 0) at = images.push(part.mediaId) - 1
          own.push(at)
        }
      return {
        who:
          message.author.kind === 'you'
            ? 'You'
            : redact(names.get(message.author.agentId) ?? 'Agent'),
        you: message.author.kind === 'you',
        at: message.createdAt,
        text,
        images: own,
      }
    })
    .filter((message) => message.text !== '' || message.images.length > 0)
  return { title: redact(room.name), messages, images }
}

const ShareRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  token_hash: z.string(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  revoked_at: z.string().nullable(),
  views: z.int().nonnegative(),
  include_images: z.union([z.literal(0), z.literal(1)]),
  snapshot: z.string(),
})
export type ShareRow = z.infer<typeof ShareRowSchema>

export function insertShare(
  sqlite: DatabaseSync,
  share: {
    id: string
    roomId: string
    tokenHash: string
    createdAt: string
    expiresAt: string
    includeImages: boolean
    snapshot: ShareSnapshot
  },
): void {
  // Old, finished shares go; their snapshots would otherwise sit in the database for good.
  const cutoff = new Date(Date.parse(share.createdAt) - 30 * DAY_MS).toISOString()
  sqlite
    .prepare('DELETE FROM room_shares WHERE expires_at < ? OR revoked_at < ?')
    .run(cutoff, cutoff)
  sqlite
    .prepare(
      `INSERT INTO room_shares (id, room_id, token_hash, created_at, expires_at, include_images, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      share.id,
      share.roomId,
      share.tokenHash,
      share.createdAt,
      share.expiresAt,
      Number(share.includeImages),
      JSON.stringify(share.snapshot),
    )
}

/** A live share by token hash: not revoked, not expired. Compares the hashes in constant time as well. */
export function findLiveShare(
  sqlite: DatabaseSync,
  token: string,
  nowIso: string,
): (ShareRow & { parsed: ShareSnapshot }) | null {
  if (!wellFormedToken(token)) return null
  const hash = hashShareToken(token)
  const value = sqlite.prepare('SELECT * FROM room_shares WHERE token_hash = ?').get(hash)
  if (!value) return null
  const row = ShareRowSchema.parse(value)
  const a = Buffer.from(row.token_hash)
  const b = Buffer.from(hash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (row.revoked_at !== null || row.expires_at <= nowIso) return null
  return { ...row, parsed: JSON.parse(row.snapshot) as ShareSnapshot }
}

export function countView(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('UPDATE room_shares SET views = views + 1 WHERE id = ?').run(id)
}

export function listShares(
  sqlite: DatabaseSync,
  nowIso: string,
  roomId?: string,
  activeOnly = false,
): ShareSummary[] {
  return z
    .array(ShareRowSchema.extend({ room_name: z.string() }))
    .parse(
      sqlite
        .prepare(
          `SELECT s.*, r.name AS room_name FROM room_shares s JOIN rooms r ON r.id = s.room_id
           WHERE s.revoked_at IS NULL AND (? IS NULL OR s.room_id = ?) AND (? = 0 OR s.expires_at > ?)
           ORDER BY s.created_at DESC, s.id`,
        )
        .all(roomId ?? null, roomId ?? null, Number(activeOnly), nowIso),
    )
    .map((row) =>
      ShareSummarySchema.parse({
        id: row.id,
        roomId: row.room_id,
        roomName: row.room_name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        views: row.views,
        includeImages: row.include_images === 1,
        status: row.expires_at > nowIso ? 'active' : 'expired',
      }),
    )
}

/** Idempotent. The snapshot is dropped as well: a revoked share keeps nothing of the conversation. */
export function revokeShare(sqlite: DatabaseSync, id: string, nowIso: string): boolean {
  const row = sqlite.prepare('SELECT id FROM room_shares WHERE id = ?').get(id)
  if (!row) return false
  sqlite
    .prepare(
      `UPDATE room_shares SET revoked_at = COALESCE(revoked_at, ?), snapshot = '{"title":"","messages":[],"images":[]}'
       WHERE id = ?`,
    )
    .run(nowIso, id)
  return true
}

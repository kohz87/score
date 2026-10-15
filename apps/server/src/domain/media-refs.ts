import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const PartsSchema = z.array(z.object({ kind: z.string(), mediaId: z.string().optional() }).loose())

/**
 * Gives back the media references of messages that stop being visible (deleted, or hidden by an edit's rewind).
 * Only the person's own messages hold references (`retain` runs when they are sent), once per distinct upload.
 * Call it for messages that are visible right now, so each reference is released once.
 */
export function releaseMessageMedia(sqlite: DatabaseSync, messageIds: readonly string[]): void {
  const read = sqlite.prepare("SELECT parts FROM messages WHERE id = ? AND author_kind = 'you'")
  const release = sqlite.prepare('UPDATE media SET refs = MAX(refs - 1, 0) WHERE id = ?')
  for (const messageId of messageIds) {
    const row = read.get(messageId) as { parts: string } | undefined
    if (!row) continue
    const parts = PartsSchema.safeParse(JSON.parse(row.parts))
    if (!parts.success) continue
    const ids = new Set<string>()
    for (const part of parts.data)
      if ((part.kind === 'image' || part.kind === 'document') && part.mediaId) ids.add(part.mediaId)
    for (const id of ids) release.run(id)
  }
}

/** A share holds one reference per distinct image it names (audit4-c #1). Call inside the transaction that inserts the share. */
export function retainShareMedia(
  sqlite: DatabaseSync,
  shareId: string,
  mediaIds: readonly string[],
  now: string,
): void {
  const add = sqlite.prepare('INSERT OR IGNORE INTO share_media (share_id, media_id) VALUES (?, ?)')
  const hold = sqlite.prepare('UPDATE media SET refs = refs + 1, last_used_at = ? WHERE id = ?')
  for (const id of new Set(mediaIds)) {
    // An image that is already gone cannot be held; the share page 404s it as before.
    if (Number(hold.run(now, id).changes) === 0) continue
    add.run(shareId, id)
  }
}

/** Releases what the given shares hold. The row is the marker, so a second call releases nothing. */
export function releaseShareMedia(sqlite: DatabaseSync, shareIds: readonly string[]): void {
  const rows = sqlite.prepare('SELECT media_id FROM share_media WHERE share_id = ?')
  const drop = sqlite.prepare('DELETE FROM share_media WHERE share_id = ?')
  const release = sqlite.prepare('UPDATE media SET refs = MAX(refs - 1, 0) WHERE id = ?')
  for (const shareId of shareIds) {
    const held = rows.all(shareId) as { media_id: string }[]
    drop.run(shareId)
    for (const row of held) release.run(row.media_id)
  }
}

/** Expired and revoked shares let go of their images (run from the media sweep and before a share is created). */
export function releaseEndedShareMedia(sqlite: DatabaseSync, nowIso: string): void {
  const ended = sqlite
    .prepare(
      `SELECT id FROM room_shares
        WHERE (revoked_at IS NOT NULL OR expires_at <= ?) AND id IN (SELECT share_id FROM share_media)`,
    )
    .all(nowIso) as { id: string }[]
  releaseShareMedia(
    sqlite,
    ended.map((row) => row.id),
  )
}

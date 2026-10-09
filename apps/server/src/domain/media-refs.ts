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

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { LAUNCHES_DIR } from '../../installation.ts'
import { syncDirectory } from './journal-files.ts'
import { nodeIo, writeAll, type JournalIo, type LaunchFolder } from './journal-io.ts'
import { HISTORY_MARKER_FILE, RESTORE_MARKER_FILE } from './journal-paths.ts'

const MarkerSchema = z.object({
  scope: z.string().min(1),
  at: z.iso.datetime(),
  backup: z.string(),
  /** `copy`: written when a copied home was confirmed as its own installation (its history is the source's). */
  origin: z.enum(['restore', 'copy']).optional(),
})
export type RestoreMarker = z.infer<typeof MarkerSchema>

/** Launch folders that hold evidence (an empty folder, made before the first record, is none). */
export function launchDirectories(dir: string): LaunchFolder[] {
  const root = join(dir, LAUNCHES_DIR)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const found: LaunchFolder[] = []
  for (const id of names) {
    try {
      const files = readdirSync(join(root, id))
      if (files.length === 0) continue
      // Newest file time: a person lifting the fence after this moment has seen the folder.
      const mtimeMs = Math.max(...files.map((f) => statSync(join(root, id, f)).mtimeMs))
      found.push({ id, mtimeMs })
    } catch {
      found.push({ id, mtimeMs: Number.MAX_SAFE_INTEGER }) // unreadable: evidence we can't date
    }
  }
  return found
}

/** Durable (temp, fsync, rename, directory fsync) and idempotent; it exists before the first record does. */
export function writeHistoryMarker(dir: string): void {
  const path = join(dir, HISTORY_MARKER_FILE)
  if (!existsSync(path)) {
    const temp = `${path}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeAll(
        nodeIo,
        fd,
        Buffer.from(JSON.stringify({ version: 1, at: new Date().toISOString() })),
      )
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }
}

/** The marker `scripts/restore.mjs` left for this home, if any. A malformed marker counts as present. */
export function readRestoreMarkerAt(
  dir: string,
  scope: string,
): RestoreMarker | 'malformed' | undefined {
  const path = join(dir, RESTORE_MARKER_FILE)
  if (!existsSync(path)) return undefined
  try {
    const marker = MarkerSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return marker.scope === scope ? marker : undefined
  } catch {
    return 'malformed'
  }
}

export function clearRestoreMarkerAt(dir: string, io: JournalIo): void {
  const path = join(dir, RESTORE_MARKER_FILE)
  try {
    renameSync(path, `${path}.consumed`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // already gone
    throw error
  }
  syncDirectory(dir, io)
}

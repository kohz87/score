import fs from 'node:fs/promises'
import path from 'node:path'
import { renameNoReplace } from './rename-noreplace.ts'

// Moves a file to a new name with one kernel call, Linux renameat2(RENAME_NOREPLACE) (see rename-noreplace.ts): the
// destination is never replaced and nothing is ever unlinked, so a file somebody else puts at either name meanwhile
// can't be lost. There is deliberately no fallback (no replacing `rename`, no link-and-unlink): on a system that
// can't do it the move is refused. Audit 3, S3-001.

/** Flushes a folder's entries to disk. Where the platform can't (some filesystems, Windows), this is a no-op. */
export async function syncDir(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP')
      throw error
  } finally {
    await handle?.close()
  }
}

/**
 * Throws 404 when the source is gone, 409 when the destination exists (both files untouched) and a plain refusal
 * when this system can't rename atomically without replacing. Returns whether the folders were flushed: the move
 * itself has happened either way, so a failed flush is reported to the caller instead of thrown.
 */
export async function moveNoReplace(source: string, dest: string): Promise<{ synced: boolean }> {
  await renameNoReplace(source, dest)
  try {
    await syncDir(path.dirname(source))
    if (path.dirname(dest) !== path.dirname(source)) await syncDir(path.dirname(dest))
    return { synced: true }
  } catch {
    return { synced: false }
  }
}

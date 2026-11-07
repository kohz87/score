import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ThemeContext, ThemeFs } from './store-types.ts'

export const realFs: ThemeFs = {
  rename: renameSync,
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  sync: fsyncPath,
}

/**
 * fsync of a file or folder. A folder is opened read-only and synced to make the names in it (a rename, a new file)
 * durable. Some systems refuse to sync a folder (EINVAL, ENOTSUP, EPERM); that is not a failure of the swap, the
 * guarantee is then only what the system gives. Any other error (EIO, ENOSPC) is real and propagates.
 */
function fsyncPath(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY)
    fsyncSync(fd)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM') throw error
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export function syncThemePath(fs: ThemeFs, path: string): void {
  const sync = fs.sync ?? fsyncPath
  sync(path)
}

/** True for anything on disk at the path, a dangling symlink included. */
export function presentOnDisk(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function stagingPath(root: string, token: string): string {
  return join(root, `.staging-${token}`)
}

export function asidePath(root: string, token: string): string {
  return join(root, `.old-${token}`)
}

/** Removal that never throws: what is left behind is swept at the next start. */
export function tryRemove(context: ThemeContext, path: string): void {
  try {
    context.fs.rm(path)
  } catch {
    // swept by recoverInterrupted
  }
}

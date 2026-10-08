import { copyFileSync, statSync, truncateSync } from 'node:fs'

export const LOG_LIMIT_BYTES = 10 * 1024 * 1024

/**
 * Keeps the launcher's append-only log bounded while the server runs: past the limit the log becomes `<file>.1`
 * (one generation) and the file is truncated in place. The launcher opened it with O_APPEND, so its descriptor
 * keeps writing at the new end; a few lines written between the copy and the truncate can be lost.
 */
export function rotateLog(path: string, limit = LOG_LIMIT_BYTES): boolean {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return false
  }
  if (size <= limit) return false
  copyFileSync(path, `${path}.1`)
  truncateSync(path, 0)
  return true
}

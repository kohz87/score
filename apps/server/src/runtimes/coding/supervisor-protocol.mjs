import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 64 * 1024
export const MAX_CHUNK_BYTES = 32 * 1024

/** Exit codes of the supervisor itself (the CLI's own code travels in the `exit` frame). */
export const EXIT = { ok: 0, failed: 1, socketLoss: 2, rejected: 3, badSpec: 4 }

/** Hash that binds a token to one spec: the spec without its token, as JSON in the file's key order. */
export function hashSpec(spec) {
  const rest = { ...spec }
  delete rest.token
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

/** Start time (clock ticks since boot) of a process, from /proc; null when unreadable. */
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

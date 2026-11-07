import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * Writes a receipt so that the final name only ever holds a complete one (design section 3, review #8): the whole body
 * goes to a temp name (short writes looped), is fsynced, then linked to the final name (link fails when it already
 * exists, which keeps the old O_EXCL "exactly once" meaning; a plain rename would overwrite), the temp name is removed
 * and the directory is fsynced. Throws on any error: callers fail closed.
 */
export function writeReceipt(dir, name, body, io = {}) {
  const write = io.writeSync ?? writeSync
  const link = io.linkSync ?? linkSync
  const sync = io.fsyncSync ?? fsyncSync
  const final = join(dir, name)
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const data = Buffer.from(JSON.stringify(body) + '\n')
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let off = 0
      while (off < data.length) {
        const n = write(fd, data, off, data.length - off)
        if (!(n > 0)) throw new Error('receipt: short write')
        off += n
      }
      sync(fd)
    } finally {
      closeSync(fd)
    }
    link(tmp, final)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // never created, or already gone
    }
  }
  syncDirectory(dir, sync)
}

export function syncDirectory(dir, sync = fsyncSync) {
  const dirFd = openSync(dir, 'r')
  try {
    sync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/**
 * Makes an EXISTING receipt durable: its contents and its directory entry are fsynced. A name that exists is not yet
 * proof that it survives a crash (the writer's directory sync may have failed), so a reader that finds `EEXIST` calls
 * this before it trusts the file. Throws on any error, including a missing file.
 */
export function syncReceipt(dir, name, io = {}) {
  const sync = io.fsyncSync ?? fsyncSync
  const fd = openSync(join(dir, name), 'r')
  try {
    sync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dir, sync)
}

/**
 * Replaces an existing receipt with a new body in one step (temp file, fsync, rename over the name, directory fsync). Used
 * for the final `acked.json`, whose `durable: true` form exists only once the directory sync of the first one succeeded.
 */
export function replaceReceipt(dir, name, body, io = {}) {
  const write = io.writeSync ?? writeSync
  const sync = io.fsyncSync ?? fsyncSync
  const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const data = Buffer.from(JSON.stringify(body) + '\n')
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      let off = 0
      while (off < data.length) {
        const n = write(fd, data, off, data.length - off)
        if (!(n > 0)) throw new Error('receipt: short write')
        off += n
      }
      sync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, join(dir, name))
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // renamed away, or never created
    }
  }
  syncDirectory(dir, sync)
}

/**
 * Parses a receipt the way every reader must (review #8): an empty, partial, malformed or foreign one is `invalid`
 * and is never proof of anything. `kind` is 'released', 'ended' or 'acked'; `expect` pins the launch and generation.
 * Returns { state: 'present', body } | { state: 'invalid' }.
 */
export function parseReceipt(text, kind, expect = {}) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { state: 'invalid' }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { state: 'invalid' }
  if (typeof body.launch !== 'string' || body.launch === '') return { state: 'invalid' }
  if (!Number.isInteger(body.generation) || !Number.isFinite(body.at)) return { state: 'invalid' }
  if (expect.launch !== undefined && body.launch !== expect.launch) return { state: 'invalid' }
  if (expect.generation !== undefined && body.generation !== expect.generation)
    return { state: 'invalid' }
  if (kind === 'released') {
    if (!Number.isInteger(body.supervisorPid)) return { state: 'invalid' }
  } else if (kind === 'ended') {
    if (!('code' in body) || !('signal' in body) || typeof body.survivorsKilled !== 'boolean')
      return { state: 'invalid' }
  } else if (kind !== 'acked') return { state: 'invalid' }
  return { state: 'present', body }
}

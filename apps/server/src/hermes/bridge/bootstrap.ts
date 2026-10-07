import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export function hashBridgeToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export function loadBridgeBootstrap(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'bridge.token')
  // Write a temporary file, then hard-link it into place: a crash can never leave an empty token behind.
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    writeFileSync(fd, randomBytes(32).toString('base64url'), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(temporary, path)
  } catch (error) {
    if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) throw error
  } finally {
    unlinkSync(temporary)
  }
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error('Bridge bootstrap token must be an owner-only regular file')
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (
      !z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .safeParse(token).success
    ) {
      throw new Error('Bridge bootstrap token has an invalid format')
    }
    return hashBridgeToken(token)
  } finally {
    closeSync(fd)
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
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

// Score's own secrets at rest (PLAN 11.1d): a webhook trigger's signing secret must be kept in plaintext form to check
// signatures, so it is sealed with AES-256-GCM under a local key file (`sealing.key`, owner-only, made once like
// `bridge.token`). The key never leaves this machine; a copied database alone opens nothing. Each sealed value is bound
// to what it is for (`context`), so one can't be swapped for another.

const KeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** Loads the sealing key, creating it on first use. Refuses a key file anyone but its owner can read. */
export function loadSealingKey(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'sealing.key')
  // A temporary file hard-linked into place: a crash never leaves an empty key, and a racing start keeps the first one.
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
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('The sealing key must be an owner-only regular file')
    const key = KeySchema.safeParse(readFileSync(fd, 'utf8').trim())
    if (!key.success) throw new Error('The sealing key has an invalid format')
    return Buffer.from(key.data, 'base64url')
  } finally {
    closeSync(fd)
  }
}

export interface Sealer {
  seal(plaintext: string, context: string): string
  /** Null when the value was not sealed by this key for this context (tampered, swapped, or another machine's). */
  unseal(sealed: string, context: string): string | null
}

/** `v1.<iv>.<ciphertext>.<tag>`, base64url parts; `context` is the authenticated associated data. */
export function sealer(key: Buffer): Sealer {
  return {
    seal(plaintext, context) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return ['v1', iv, body, cipher.getAuthTag()]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.')
    },
    unseal(sealed, context) {
      const [version, iv, body, tag] = sealed.split('.')
      if (version !== 'v1' || !iv || body === undefined || !tag) return null
      try {
        // A pinned tag length: GCM would otherwise accept a truncated tag.
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
          authTagLength: 16,
        })
        decipher.setAAD(Buffer.from(context, 'utf8'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        return null
      }
    },
  }
}

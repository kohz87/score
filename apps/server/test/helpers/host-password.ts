import { randomBytes, scryptSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { passwordDigest } from '../../src/auth/security-password.ts'

/** What `scripts/score password` does on the host: the password file plus the "host" mark tied to its hash. */
export function hostPassword(home: string, password: string): void {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const line = `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
  writeFileSync(join(home, 'security-password'), `${line}\n`, { mode: 0o600 })
  writeFileSync(join(home, 'security-password.origin'), `host ${passwordDigest(line)}\n`, {
    mode: 0o600,
  })
}

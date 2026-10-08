import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { SecurityPassword } from '../../src/auth/security-password.ts'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-pw-'))
  homes.push(dir)
  return dir
}

test('a password set by `score password` on the host (scripts/set-password.mjs format) verifies on the server', async () => {
  const dir = home()
  const salt = randomBytes(16)
  const key = scryptSync('host password 1', salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  writeFileSync(
    join(dir, 'security-password'),
    `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}\n`,
    { mode: 0o600 },
  )
  const security = new SecurityPassword(dir)
  expect(security.isSet()).toBe(true)
  await expect(security.verify('host password 1')).resolves.toBeUndefined()
  await expect(security.verify('wrong one!')).rejects.toMatchObject({ status: 403 })
})

test('the stored file holds only a salted hash and is private to the owner', async () => {
  const dir = home()
  const security = new SecurityPassword(dir)
  await security.set('plain text secret', undefined)
  const path = join(dir, 'security-password')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  const { readFileSync } = await import('node:fs')
  expect(readFileSync(path, 'utf8')).not.toContain('plain text secret')
})

test("one browser's wrong guesses don't lock out another, and a new password clears the lockout", async () => {
  const dir = home()
  const security = new SecurityPassword(dir)
  await security.set('owner password', undefined)
  for (let i = 0; i < 5; i++)
    await expect(security.verify('wrong guess!', 'compromised')).rejects.toMatchObject({
      status: 403,
    })
  await expect(security.verify('owner password', 'compromised')).rejects.toMatchObject({
    status: 429,
  })
  // The owner's own browser is not locked out by the compromised one.
  await expect(security.verify('owner password', 'owner')).resolves.toBeUndefined()
  // Resetting the password (e.g. `scripts/score password` on the host) clears the lockout.
  await new SecurityPassword(dir).set('fresh password', 'owner password', 'owner')
  await expect(security.verify('fresh password', 'compromised')).resolves.toBeUndefined()
})

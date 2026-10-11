import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Deterministic barrier around scrypt: while `gate.hold` is set every derivation parks until `gate.release()`.
const gate = vi.hoisted(() => ({
  hold: false,
  parked: [] as (() => void)[],
  waiters: [] as { n: number; resolve: () => void }[],
  arrived(n: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ n, resolve })
      this.poke()
    })
  },
  poke() {
    for (const w of this.waiters.filter((w) => this.parked.length >= w.n)) w.resolve()
    this.waiters = this.waiters.filter((w) => this.parked.length < w.n)
  },
  release() {
    for (const go of this.parked.splice(0)) go()
  },
}))

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  const scrypt = (...args: unknown[]) => {
    const cb = args.pop() as (...a: unknown[]) => void
    const run = () => (real.scrypt as (...a: unknown[]) => void)(...args, cb)
    if (!gate.hold) return run()
    gate.parked.push(run)
    gate.poke()
  }
  return { ...real, scrypt }
})

import {
  hashPassword,
  SecurityPassword,
  writePasswordFile,
} from '../src/auth/security-password.ts'

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'score-secpw-'))
  gate.hold = false
})
afterEach(() => {
  gate.hold = false
  gate.release()
  vi.restoreAllMocks()
  fs.chmodSync(join(home), 0o700)
  fs.rmSync(home, { recursive: true, force: true })
})

async function install(password: string): Promise<string> {
  const stored = await hashPassword(password)
  writePasswordFile(home, stored)
  return stored
}

test('SCORE-007: two first-time setters racing: one wins, the other conflicts', async () => {
  const sp = new SecurityPassword(home)
  gate.hold = true
  const a = sp.set('first password one', undefined)
  const b = sp.set('first password two', undefined)
  const results = Promise.allSettled([a, b])
  await gate.arrived(2)
  gate.hold = false
  gate.release()
  const [ra, rb] = await results
  expect([ra!.status, rb!.status].sort()).toEqual(['fulfilled', 'rejected'])
  const lost = (ra!.status === 'rejected' ? ra : rb) as PromiseRejectedResult
  expect(lost.reason).toMatchObject({ status: 409 })
})

test('SCORE-007: two rotations from the same current password: one conflicts', async () => {
  await install('original password')
  const sp = new SecurityPassword(home)
  gate.hold = true
  const results = Promise.allSettled([
    sp.set('rotated password one', 'original password'),
    sp.set('rotated password two', 'original password'),
  ])
  await gate.arrived(2) // both verifications
  gate.release()
  await gate.arrived(2) // both new hashes
  gate.hold = false
  gate.release()
  const settled = await results
  expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
})

test('SCORE-008: a verification in flight fails when the credential is replaced meanwhile', async () => {
  await install('original password')
  const sp = new SecurityPassword(home)
  gate.hold = true
  const verifying = sp.verify('original password').then(
    () => 'ok',
    (e: unknown) => e,
  )
  await gate.arrived(1)
  writePasswordFile(home, await hashPasswordUngated('host reset password'))
  gate.hold = false
  gate.release()
  expect(await verifying).toMatchObject({ status: expect.any(Number) })
})

async function hashPasswordUngated(p: string): Promise<string> {
  const was = gate.hold
  gate.hold = false
  try {
    return await hashPassword(p)
  } finally {
    gate.hold = was
  }
}

test('SCORE-009: only a missing file counts as unset; unreadable or corrupt storage fails closed', async () => {
  const sp = new SecurityPassword(home)
  expect(sp.isSet()).toBe(false)
  const path = join(home, 'security-password')
  for (const content of ['not a hash\n', '']) {
    fs.writeFileSync(path, content, { mode: 0o600 })
    await expect(sp.set('attacker password', undefined)).rejects.toMatchObject({ status: 503 })
    await expect(sp.verify('anything at all')).rejects.toMatchObject({ status: 503 })
    expect(fs.readFileSync(path, 'utf8')).toBe(content)
  }
  fs.rmSync(path)
  await install('original password')
  fs.chmodSync(path, 0o000)
  await expect(sp.set('attacker password', undefined)).rejects.toMatchObject({ status: 503 })
  fs.chmodSync(path, 0o600)
  // ENOENT is the intentional bootstrap
  fs.rmSync(path)
  await sp.set('bootstrap password', undefined)
  expect(sp.isSet()).toBe(true)
})

test('SCORE-010: a failed replacement does not block the next one', async () => {
  const stored = await hashPassword('original password')
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('rename failed')
  })
  expect(() => writePasswordFile(home, stored)).toThrow('rename failed')
  rename.mockRestore()
  writePasswordFile(home, stored)
  expect(fs.readFileSync(join(home, 'security-password'), 'utf8').trim()).toBe(stored)
  expect(fs.readdirSync(home)).toEqual(['security-password'])
})

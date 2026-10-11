import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { PasswordLockError, withPasswordLock } from '../src/auth/password-store.ts'
import { SecurityPassword, writePasswordFile, hashPassword } from '../src/auth/security-password.ts'

const child = fileURLToPath(new URL('./helpers/password-writer-child.ts', import.meta.url))
let home: string
const started: number[] = []
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-secpw-proc-'))
})
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already exited
    }
  fs.rmSync(home, { recursive: true, force: true })
})

function run(args: string[]): { done: Promise<{ code: number | null; out: string; err: string }> } {
  const proc = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', child, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  started.push(proc.pid!)
  let out = ''
  let err = ''
  proc.stdout.on('data', (chunk) => (out += chunk))
  proc.stderr.on('data', (chunk) => (err += chunk))
  return {
    done: new Promise((resolve) => proc.on('close', (code) => resolve({ code, out, err }))),
  }
}
const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// S2-024
test('a host reset during a browser change waits for the lock; the end state is one consistent publication', async () => {
  writePasswordFile(home, await hashPassword('original password'))
  const ready = join(home, 'ready')
  const go = join(home, 'go')
  const browser = run(['browser', home, 'browser new password', 'original password', ready, go])
  await until(() => fs.existsSync(ready))
  // The browser has passed its final comparison and holds the lock; the host command must not slip in.
  const host = run(['host', home, 'host reset password'])
  let hostFinished = false
  void host.done.then(() => (hostFinished = true))
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(hostFinished).toBe(false)
  fs.writeFileSync(go, 'x')
  const [b, h] = await Promise.all([browser.done, host.done])
  expect(b.err).toBe('')
  expect(h.err).toBe('')
  expect(h.out).toContain('host-done')
  // The host ran last, so its reset is the working credential and its provenance matches it.
  const sp = new SecurityPassword(home)
  await sp.verify('host reset password')
  await expect(sp.verify('browser new password')).rejects.toMatchObject({ status: 403 })
  expect(sp.hostIssued()).toBe(true)
  expect(fs.existsSync(join(home, 'security-password.lock'))).toBe(false)
})

test('a lock left by a process that is gone is recovered; a live holder blocks until the wait runs out', async () => {
  const lock = join(home, 'security-password.lock')
  fs.writeFileSync(lock, '999999 1\n')
  await expect(withPasswordLock(home, () => 'ran')).resolves.toBe('ran')
  // A lock naming this live process and its real start time is respected.
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  const start = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(' ')[19]
  fs.writeFileSync(lock, `${process.pid} ${start}\n`)
  await expect(withPasswordLock(home, () => 'ran', 300)).rejects.toBeInstanceOf(PasswordLockError)
  // The same pid with another start time is a reused pid: stale.
  fs.writeFileSync(lock, `${process.pid} 1\n`)
  await expect(withPasswordLock(home, () => 'ran')).resolves.toBe('ran')
})

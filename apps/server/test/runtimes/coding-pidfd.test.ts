import { execFileSync, spawn } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import {
  killRecordedGroup,
  processStart,
  realProcEnv,
  bootId,
} from '../../src/runtimes/coding/proc.ts'
import { pidfdSupport, signalGroup, signalPid } from '../../src/runtimes/coding/pidfd-signal.ts'

// Fix batch Y (Y1): pid-directed signals go through a pidfd that pins the process, so a reused pid is never hit.

const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone
    }
})
const sleeper = () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  started.push(child.pid!)
  return child.pid!
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    // A zombie still answers signal 0.
    return processStart(pid) !== null && !/^\d+ \(.*\) Z/.test(statLine(pid))
  } catch {
    return false
  }
}
const statLine = (pid: number) => execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' })
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitDead = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await settle(50)
}

test('the probe finds an interpreter with pidfd support here', () => {
  expect(pidfdSupport().python).not.toBeNull()
})

test('Y1 helper: a matching start time is signalled', async () => {
  const pid = sleeper()
  await settle(200)
  expect(signalPid(pid, processStart(pid)!, 'SIGKILL')).toBe('signalled')
  await waitDead(pid)
  expect(alive(pid)).toBe(false)
})

test('Y1 helper: signal 0 verifies without signalling', async () => {
  const pid = sleeper()
  await settle(200)
  expect(signalPid(pid, processStart(pid)!, 0)).toBe('signalled')
  expect(alive(pid)).toBe(true)
})

test('Y1 helper: a live process with a different start time (a reused pid) is not signalled', async () => {
  const pid = sleeper()
  await settle(200)
  const wrong = String(Number(processStart(pid)) - 1000)
  expect(signalPid(pid, wrong, 'SIGKILL')).toBe('mismatch')
  await settle(200)
  expect(alive(pid)).toBe(true)
})

test('Y1 helper: a process that is already gone is a mismatch', async () => {
  const pid = sleeper()
  await settle(200)
  const start = processStart(pid)!
  process.kill(-pid, 'SIGKILL')
  await waitDead(pid)
  // Reaped by init once its parent (us) lets go; a zombie would still hold the pid and match, which is also fine.
  const result = signalPid(pid, start, 'SIGTERM')
  expect(['mismatch', 'signalled']).toContain(result)
})

test('Y1 helper: a batch signals only the matching targets, one line each', async () => {
  const a = sleeper()
  const b = sleeper()
  await settle(200)
  const python = pidfdSupport().python!
  const script = new URL('../../src/runtimes/coding/pidfd-signal.py', import.meta.url).pathname
  let out = ''
  let status = 0
  try {
    execFileSync(
      python,
      ['-I', script, '9', `${a}:${processStart(a)}`, `${b}:${Number(processStart(b)) + 1}`],
      { encoding: 'utf8' },
    )
  } catch (error) {
    const e = error as { status: number; stdout: string }
    status = e.status
    out = e.stdout
  }
  expect(status).toBe(3)
  expect(out.trim().split('\n')).toEqual([`${a} 0`, `${b} 3`])
  await waitDead(a)
  expect(alive(a)).toBe(false)
  expect(alive(b)).toBe(true)
})

test('Y1 helper: bad usage exits 5, an unusable interpreter is unavailable', async () => {
  const python = pidfdSupport().python!
  const script = new URL('../../src/runtimes/coding/pidfd-signal.py', import.meta.url).pathname
  let status = 0
  try {
    execFileSync(python, ['-I', script, 'x'], { stdio: 'ignore' })
  } catch (error) {
    status = (error as { status: number }).status
  }
  expect(status).toBe(5)
  const pid = sleeper()
  await settle(200)
  expect(signalPid(pid, processStart(pid)!, 'SIGKILL', '/nonexistent/python3')).toBe('unavailable')
  expect(signalPid(pid, processStart(pid)!, 'SIGKILL', null)).toBe('unavailable')
  expect(alive(pid)).toBe(true)
})

test('Y1 real: no usable python means nothing is signalled and the outcome is unobservable', async () => {
  const pid = sleeper()
  await settle(200)
  const env = {
    ...realProcEnv,
    signalPid: () => signalPid(pid, '1', 0, null),
    signalGroup: () => signalGroup(pid, '1', 'SIGTERM', null),
  }
  const outcome = await killRecordedGroup(
    { pid, pgid: pid, startTime: processStart(pid), bootId: bootId() },
    200,
    env,
  )
  expect(outcome).toBe('unobservable')
  expect(alive(pid)).toBe(true)
})

test('Y1 real: the recorded leader is verified and stopped, a process outside its group is untouched', async () => {
  const leader = sleeper()
  await settle(200)
  const member = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: 'ignore',
    detached: false,
  })
  member.unref()
  started.push(member.pid!)
  const outcome = await killRecordedGroup(
    { pid: leader, pgid: leader, startTime: processStart(leader), bootId: bootId() },
    500,
  )
  expect(outcome).toBe('gone')
  await waitDead(leader)
  expect(alive(leader)).toBe(false)
  expect(alive(member.pid!)).toBe(true) // not in the group: untouched
})

/** A group leader that has started one child in the same group; returns both pids. */
async function groupOfTwo() {
  const leader = spawn(
    process.execPath,
    [
      '-e',
      `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
       console.log(c.pid); setTimeout(() => {}, 120000)`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  leader.unref()
  started.push(leader.pid!)
  const child = await new Promise<number>((resolve) =>
    leader.stdout!.once('data', (d) => resolve(Number(String(d).trim()))),
  )
  return { leader: leader.pid!, child }
}

test('Y1 group: the signal reaches the whole real group through the leader pidfd', async () => {
  const { leader, child } = await groupOfTwo()
  expect(signalGroup(leader, processStart(leader)!, 'SIGKILL')).toBe('signalled')
  await waitDead(child)
  await waitDead(leader)
  expect(alive(child)).toBe(false)
  expect(alive(leader)).toBe(false)
})

test('Y1 group: a replaced leader (start time mismatch) signals nobody', async () => {
  const { leader, child } = await groupOfTwo()
  const wrong = String(Number(processStart(leader)) + 1)
  expect(signalGroup(leader, wrong, 'SIGKILL')).toBe('mismatch')
  await settle(200)
  expect(alive(leader)).toBe(true)
  expect(alive(child)).toBe(true)
})

test('Y1 group: no python means nothing is sent', async () => {
  const { leader, child } = await groupOfTwo()
  expect(signalGroup(leader, processStart(leader)!, 'SIGKILL', null)).toBe('unavailable')
  expect(signalGroup(leader, processStart(leader)!, 'SIGKILL', '/nonexistent/python3')).toBe(
    'unavailable',
  )
  expect(alive(leader)).toBe(true)
  expect(alive(child)).toBe(true)
})

test('Y1 group: any non-mismatch failure of the helper (as for an unsupported flag, exit 4) is reported unavailable', () => {
  // A stand-in interpreter that fails; the flag-unsupported path itself is covered with an injected env in coding-proc.test.ts.
  const fake = '/usr/bin/false'
  expect(signalGroup(process.pid + 100000, '1', 'SIGTERM', fake)).toBe('unavailable')
})

import { spawn } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import {
  bootId,
  killRecordedGroup,
  processStart,
  type ProcEnv,
} from '../../src/runtimes/coding/proc.ts'

// Fix batch W (W1, W2): recovery signals only what it can prove is ours, and says whether the group is gone.

interface FakeProc {
  state?: string
  pgrp: number
  start: number
  ppid?: number
}
/** A fake process table. `ignores` = pids that survive every signal. */
function fakeEnv(
  procs: Record<number, FakeProc>,
  boot: string | null = 'boot-1',
  ignores = new Set<number>(),
) {
  const signals: [number, string][] = []
  let listable = true
  /** pids whose stat can't be read (EACCES), and pids the listing misses (forked after it was read). */
  const unreadable = new Set<number>()
  const hidden = new Set<number>()
  /** Runs `apply` just before the nth stat read of `pid` is answered (a pid reused between scan and signal). */
  const swaps: { pid: number; nth: number; apply(): void; seen: number }[] = []
  const env: ProcEnv = {
    stat: (pid) => {
      for (const swap of swaps) {
        if (swap.pid === pid && ++swap.seen === swap.nth) swap.apply()
      }
      if (unreadable.has(pid)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const p = procs[pid]
      // fields after the command name: [state, ppid, pgrp, session, …, start at index 19]
      return p
        ? [
            p.state ?? 'S',
            String(p.ppid ?? 1),
            String(p.pgrp),
            '1',
            ...Array(15).fill('0'),
            String(p.start),
          ]
        : null
    },
    pids: () =>
      listable
        ? Object.keys(procs)
            .map(Number)
            .filter((pid) => !hidden.has(pid))
        : null,
    kill: (pid, signal) => {
      signals.push([pid, signal])
      const targets =
        pid < 0
          ? Object.keys(procs)
              .map(Number)
              .filter((q) => procs[q]!.pgrp === -pid)
          : [pid]
      for (const q of targets) if (!ignores.has(q) && signal !== 'SIGHUP') delete procs[q]
    },
    groupExists: (pgid) => (Object.values(procs).some((p) => p.pgrp === pgid) ? 'exists' : 'none'),
    bootId: () => boot,
  }
  return {
    env,
    procs,
    signals,
    unreadable,
    hidden,
    swaps,
    setListable: (value: boolean) => (listable = value),
  }
}

test('a record from another boot is gone by definition: nothing is signalled', async () => {
  const world = fakeEnv({ 500: { pgrp: 500, start: 77 }, 501: { pgrp: 500, start: 78 } }, 'boot-2')
  const outcome = await killRecordedGroup(
    { pid: 500, pgid: 500, startTime: '77', bootId: 'boot-1' },
    50,
    world.env,
  )
  expect(outcome).toBe('gone')
  expect(world.signals).toEqual([])
})

test('a pid reused by a new, unrelated group is never signalled (the old filter accepted any later start)', async () => {
  // Ours (pid 500, start 77) emptied; the kernel gave 500 to a new leader that started later, with a child.
  const world = fakeEnv({ 500: { pgrp: 500, start: 9000 }, 510: { pgrp: 500, start: 9001 } })
  const outcome = await killRecordedGroup(
    { pid: 500, pgid: 500, startTime: '77', bootId: 'boot-1' },
    50,
    world.env,
  )
  expect(outcome).toBe('gone')
  expect(world.signals).toEqual([])
})

test('with no process on the recorded pid, members recorded while Score supervised the run are stopped', async () => {
  const world = fakeEnv({
    510: { pgrp: 500, start: 90 },
    511: { pgrp: 500, start: 91, ppid: 510 },
    900: { pgrp: 900, start: 5 },
  })
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 510, startTime: '90' }],
    },
    50,
    world.env,
  )
  expect(outcome).toBe('gone')
  // 511 was never recorded but descends from 510, which was.
  expect(world.signals.map(([pid]) => pid).sort()).toEqual([510, 511])
  expect(world.signals.every(([pid]) => pid !== 900)).toBe(true)
})

test('N4: a replacement group that reused the number, whose leader exited, is never signalled (unobservable)', async () => {
  // Ours (500, start 77) emptied; a new leader got pid/pgid 500, started 510, and exited. 510 is an orphan of the
  // replacement group. Nothing recorded matches it, so it may not be ours.
  const world = fakeEnv({ 510: { pgrp: 500, start: 9001, ppid: 1 } })
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 501, startTime: '78' }],
    },
    50,
    world.env,
  )
  expect(outcome).toBe('unobservable')
  expect(world.signals).toEqual([])
})

test('N4: a recorded pid that has since been reused (different start time) does not vouch for a stranger', async () => {
  const world = fakeEnv({ 501: { pgrp: 500, start: 9002, ppid: 1 } })
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 501, startTime: '78' }],
    },
    50,
    world.env,
  )
  expect(outcome).toBe('unobservable')
  expect(world.signals).toEqual([])
})

test('N4: continuity is also learned while the leader is alive, and passed to the recorder', async () => {
  const world = fakeEnv({ 500: { pgrp: 500, start: 77 }, 501: { pgrp: 500, start: 78, ppid: 500 } })
  const seen: number[] = []
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      onMembers: (members) => seen.push(...members.map((m) => m.pid)),
    },
    50,
    world.env,
  )
  expect(outcome).toBe('gone')
  expect(seen).toEqual([501])
})

test('X3: a pid that was reused between the scan and the signal is skipped', async () => {
  const world = fakeEnv({ 510: { pgrp: 500, start: 90 } })
  // Calls on 510: the first inspection, the inspection inside signal(), then the re-read right before kill.
  world.swaps.push({
    pid: 510,
    nth: 3,
    seen: 0,
    apply: () => {
      world.env.stat(510)
      // The process ended and an unrelated one took its pid, in another group.
      delete world.procs[510]
      world.procs[510] = { pgrp: 777, start: 9999 }
    },
  })
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 510, startTime: '90' }],
    },
    50,
    world.env,
  )
  expect(world.signals.filter(([pid]) => pid === 510)).toEqual([])
  expect(outcome).toBe('gone')
})

test('N5: an unreadable stat is not absence: unobservable, nothing signalled', async () => {
  const world = fakeEnv({ 510: { pgrp: 500, start: 90 } })
  world.unreadable.add(510)
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 510, startTime: '90' }],
    },
    50,
    world.env,
  )
  expect(outcome).toBe('unobservable')
  expect(world.signals).toEqual([])
})

test('N5: a child missing from the listing (fork race) keeps the group from being called gone', async () => {
  const world = fakeEnv({
    510: { pgrp: 500, start: 90 },
    520: { pgrp: 500, start: 95, ppid: 510 },
  })
  world.hidden.add(520)
  const outcome = await killRecordedGroup(
    {
      pid: 500,
      pgid: 500,
      startTime: '77',
      bootId: 'boot-1',
      members: [{ pid: 510, startTime: '90' }],
    },
    50,
    world.env,
  )
  // The kernel still reports the group: an empty scan must not override it.
  expect(outcome).not.toBe('gone')
})

test('a row without a boot id never has a lone group member signalled (it can not be tied to the record)', async () => {
  const world = fakeEnv({ 510: { pgrp: 500, start: 90 } })
  const outcome = await killRecordedGroup(
    { pid: 500, pgid: 500, startTime: '77', bootId: null },
    50,
    world.env,
  )
  expect(outcome).toBe('unobservable')
  expect(world.signals).toEqual([])
})

test('survivors that ignore SIGKILL are reported alive, never gone', async () => {
  const world = fakeEnv(
    { 500: { pgrp: 500, start: 77 }, 501: { pgrp: 500, start: 78 } },
    'boot-1',
    new Set([501]),
  )
  const outcome = await killRecordedGroup(
    { pid: 500, pgid: 500, startTime: '77', bootId: 'boot-1' },
    50,
    world.env,
  )
  expect(outcome).toBe('alive')
  expect(world.signals.some(([, name]) => name === 'SIGKILL')).toBe(true)
})

test('an unreadable process table is unobservable, not gone', async () => {
  const world = fakeEnv({ 500: { pgrp: 500, start: 77 } })
  world.setListable(false)
  expect(
    await killRecordedGroup(
      { pid: 500, pgid: 500, startTime: '77', bootId: 'boot-1' },
      50,
      world.env,
    ),
  ).toBe('unobservable')
  expect(world.signals).toEqual([])
  // Boot id unknown while the record has one: also can't tell.
  const noBoot = fakeEnv({ 500: { pgrp: 500, start: 77 } }, null)
  expect(
    await killRecordedGroup(
      { pid: 500, pgid: 500, startTime: '77', bootId: 'boot-1' },
      50,
      noBoot.env,
    ),
  ).toBe('unobservable')
})

// Real processes, real /proc.
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
    return true
  } catch {
    return false
  }
}

test('real: a live group under a reused pid (start time differs) is left alone', async () => {
  const pid = sleeper()
  await new Promise((r) => setTimeout(r, 200))
  const outcome = await killRecordedGroup(
    {
      pid,
      pgid: pid,
      startTime: String(Number(processStart(pid)) - 1000),
      bootId: bootId(),
    },
    200,
  )
  expect(outcome).toBe('gone')
  expect(alive(pid)).toBe(true)
})

test('real: the recorded leader (pid, start time and boot match) is stopped and proven gone', async () => {
  const pid = sleeper()
  await new Promise((r) => setTimeout(r, 200))
  const outcome = await killRecordedGroup(
    { pid, pgid: pid, startTime: processStart(pid), bootId: bootId() },
    500,
  )
  expect(outcome).toBe('gone')
  await new Promise((r) => setTimeout(r, 100))
  expect(alive(pid)).toBe(false)
})

test('real: a record from another boot leaves a live process alone', async () => {
  const pid = sleeper()
  await new Promise((r) => setTimeout(r, 200))
  const outcome = await killRecordedGroup(
    {
      pid,
      pgid: pid,
      startTime: processStart(pid),
      bootId: 'some-earlier-boot',
    },
    200,
  )
  expect(outcome).toBe('gone')
  expect(alive(pid)).toBe(true)
})

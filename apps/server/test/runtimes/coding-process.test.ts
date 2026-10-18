import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { signalGroup as realSignalGroup } from '../../src/runtimes/coding/pidfd-signal.ts'
import { spawnCli } from '../../src/runtimes/coding/process.ts'
import { realProcEnv, type ProcEnv } from '../../src/runtimes/coding/proc.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-coding-proc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('fix-l: Stop keeps escalating until a signal-ignoring descendant is gone, even when the CLI exits first', async () => {
  const pidFile = join(dir, 'descendant.pid')
  const descendant = join(dir, 'descendant.mjs')
  writeFileSync(
    descendant,
    `import { writeFileSync } from 'node:fs'
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`,
  )
  const leader = join(dir, 'leader.mjs')
  writeFileSync(
    leader,
    `import { spawn } from 'node:child_process'
// Streams redirected away, so the leader's pipes close when it exits.
spawn(process.execPath, [${JSON.stringify(descendant)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' })
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`,
  )
  const noted = new Set<number>()
  const run = spawnCli({
    file: process.execPath,
    args: [leader],
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '' },
    stdin: '',
    parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
    onEvent: async () => undefined,
    graceMs: 150,
    onMembers: (members) => members.forEach((member) => noted.add(member.pid)),
  })
  await vi.waitFor(
    () => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8')).toBeTruthy(),
    {
      timeout: 30_000,
    },
  )
  const descendantPid = Number(readFileSync(pidFile, 'utf8'))
  expect(alive(descendantPid)).toBe(true)
  // Score only signals what it saw while the CLI lived (the member scan runs every 100 ms). Stop before that scan and
  // the descendant is, rightly, not ours to kill: so Stop only once Score has noted it.
  await vi.waitFor(() => expect(noted.has(descendantPid)).toBe(true))
  try {
    run.stop('user')
    const outcome = await run.done
    expect(outcome.stopped).toBe('user')
    // The turn is only reported over once nothing of the group is left running.
    expect(alive(descendantPid)).toBe(false)
  } finally {
    if (alive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
  }
}, 60_000)

const noParser = { parse: () => [], stats: { unknown: 0, malformed: 0 } }
const baseOptions = (args: string[]) => ({
  file: process.execPath,
  args,
  cwd: tmpdir(),
  env: { PATH: process.env['PATH'] ?? '' },
  stdin: '',
  parser: noParser,
  onEvent: async () => undefined,
})
const waitGone = async (pid: number) => {
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000 })
}

/**
 * A leader that starts a harmless worker (its pid goes to a file) and exits once Score has noted that worker. The note
 * is awaited, not guessed: Score only treats a process as its own if it saw it while the leader lived, so a leader that
 * left after a fixed delay left a race on a busy machine. `seen` is the `onMembers` the test passes to `spawnCli`
 * (a test with its own `onMembers` calls it first). `stdio` is the worker's.
 */
function leaderAndWorker(stdio: 'inherit' | 'ignore') {
  const pidFile = join(dir, `worker-${stdio}.pid`)
  const seenFile = join(dir, `worker-${stdio}.seen`)
  const worker = join(dir, 'worker.mjs')
  writeFileSync(
    worker,
    `import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`,
  )
  const leader = join(dir, `leader-${stdio}.mjs`)
  writeFileSync(
    leader,
    `import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
spawn(process.execPath, [${JSON.stringify(worker)}, ${JSON.stringify(pidFile)}], { stdio: ${JSON.stringify(stdio)} })
const wait = setInterval(() => { if (existsSync(${JSON.stringify(seenFile)})) setTimeout(() => process.exit(0), 50) }, 10)
`,
  )
  // Score reports a member once, and it may do so before the worker has written its pid file: keep every pid reported.
  const reported = new Set<number>()
  const seen = (members: { pid: number }[]) => members.forEach((member) => reported.add(member.pid))
  /** The worker's pid, once the worker runs and Score has noted it; this is also what lets the leader go. */
  const workerSeen = async () => {
    const pid = await workerPid(pidFile)
    await vi.waitFor(() => expect(reported.has(pid)).toBe(true))
    writeFileSync(seenFile, '')
    return pid
  }
  return { leader, pidFile, seen, workerSeen }
}
const workerPid = async (pidFile: string) => {
  await vi.waitFor(
    () => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8')).toBeTruthy(),
    {
      timeout: 30_000,
    },
  )
  return Number(readFileSync(pidFile, 'utf8'))
}

test('S2-004: when onSpawn throws, the child group is killed and the error propagates', async () => {
  const sleeper = join(dir, 'sleeper.mjs')
  writeFileSync(sleeper, 'setInterval(() => {}, 1000)\n')
  let pid = 0
  expect(() =>
    spawnCli({
      ...baseOptions([sleeper]),
      onSpawn: (spawned) => {
        pid = spawned
        throw new Error('database is locked')
      },
    }),
  ).toThrow('database is locked')
  expect(pid).toBeGreaterThan(0)
  try {
    await waitGone(pid)
  } finally {
    if (alive(pid)) process.kill(-pid, 'SIGKILL')
  }
})

// The limit is a real timer armed at spawn, and how long a loaded machine takes to start the launcher, the leader and
// the worker decides whether a few hundred ms is "before" or "after" the leader's exit. So the test takes the timer
// itself: spawnCli's limit has a recognisable value, setTimeout hands its callback to the test instead of arming it, and
// the test fires it once the worker really outlives its leader. Nothing here depends on how fast anything runs; if the
// limit were not armed, or did not stop the group, the test would fail.
const LIMIT_MS = 987_654_321
function captureLimitTimer() {
  const captured: { fire?: () => void } = {}
  const real = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number,
    ...rest: never[]
  ) => {
    if (ms !== LIMIT_MS)
      return (real as (...args: unknown[]) => NodeJS.Timeout)(callback, ms, ...rest)
    captured.fire = callback
    // A real, inert timer: the code under test clears it like its own.
    return real(() => undefined, 0)
  }) as typeof setTimeout)
  return { captured, restore: () => spy.mockRestore() }
}

test.each(['inherit', 'ignore'] as const)(
  'S2-005: the wall-clock limit stops a worker that outlives its leader (worker stdio %s)',
  async (stdio) => {
    const { leader, seen, workerSeen } = leaderAndWorker(stdio)
    const limit = captureLimitTimer()
    let pid = 0
    try {
      const run = spawnCli({
        ...baseOptions([leader]),
        maxMs: LIMIT_MS,
        graceMs: 3_000,
        onMembers: seen,
      })
      expect(limit.captured.fire, 'the limit timer is armed with the given limit').toBeTypeOf(
        'function',
      )
      pid = await workerSeen()
      // The leader exits on its own once the worker runs; only then does the limit run out.
      const leaderPid = run.pid!
      await vi.waitFor(() => expect(alive(leaderPid)).toBe(false))
      expect(alive(pid)).toBe(true)
      limit.captured.fire!()
      const outcome = await run.done
      expect(outcome.stopped).toBe('timeout')
      expect(outcome.groupGone).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally {
      limit.restore()
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
    }
  },
  60_000,
)

test.each(['inherit', 'ignore'] as const)(
  'S2-005: Stop reaches a worker after its leader has exited (worker stdio %s)',
  async (stdio) => {
    const { leader, seen, workerSeen } = leaderAndWorker(stdio)
    const run = spawnCli({ ...baseOptions([leader]), graceMs: 3_000, onMembers: seen })
    const pid = await workerSeen()
    // The leader is gone; the worker is not.
    const leaderPid = run.pid!
    await vi.waitFor(() => expect(alive(leaderPid)).toBe(false))
    expect(alive(pid)).toBe(true)
    try {
      run.stop('user')
      const outcome = await run.done
      expect(outcome.stopped).toBe('user')
      expect(alive(pid)).toBe(false)
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  },
  60_000,
)

test('S2-005: a leader that exits cleanly with a worker running gets the grace period, then the group is stopped and noted', async () => {
  const { leader, seen, workerSeen } = leaderAndWorker('ignore')
  const started = Date.now()
  const run = spawnCli({ ...baseOptions([leader]), graceMs: 500, onMembers: seen })
  const pid = await workerSeen()
  try {
    const outcome = await run.done
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stopped).toBeNull()
    expect(outcome.leftovers).toBe(true)
    expect(outcome.groupGone).toBe(true)
    // done settled only once the worker was gone, and not before the grace period.
    expect(alive(pid)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}, 60_000)

test('N4: the identity of a worker that outlives its leader is reported while the group is supervised', async () => {
  const { leader, seen, workerSeen } = leaderAndWorker('ignore')
  const reported: { pid: number; startTime: string }[] = []
  const run = spawnCli({
    ...baseOptions([leader]),
    graceMs: 300,
    onMembers: (members) => {
      reported.push(...members)
      seen(members)
    },
  })
  const pid = await workerSeen()
  try {
    await run.done
    expect(reported.map((member) => member.pid)).toContain(pid)
    expect(reported.every((member) => member.startTime.length > 0)).toBe(true)
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}, 60_000)

test('S3-005: members whose first recording failed are offered again and recorded by a later scan', async () => {
  const { leader, seen, workerSeen } = leaderAndWorker('ignore')
  const recorded = new Set<number>()
  const errors: unknown[] = []
  let calls = 0
  const run = spawnCli({
    ...baseOptions([leader]),
    graceMs: 600,
    onMembers: (members) => {
      seen(members)
      // The very first save fails (a busy database); nothing is kept from it.
      if (calls++ === 0) throw new Error('database is busy')
      for (const member of members) recorded.add(member.pid)
    },
    onMembersError: (error) => errors.push(error),
  })
  const pid = await workerSeen()
  try {
    await run.done
    expect(calls).toBeGreaterThan(1)
    expect(recorded.has(pid)).toBe(true)
    expect(errors).toHaveLength(1)
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}, 60_000)

test('v6-5: after the leader exits, a process that reuses the group number is neither signalled nor recorded', async () => {
  const recorded: number[] = []
  const signalled: number[] = []
  const FOREIGN = 999_999
  const run: { pid?: number } = {}
  // A replacement member of a reissued group number: not recorded while the leader lived, its parent is init.
  const env: ProcEnv = {
    ...realProcEnv,
    // Appears only once the leader is gone (its number was reissued).
    pids: () => [
      ...(realProcEnv.pids() ?? []),
      ...(run.pid !== undefined && realProcEnv.stat(run.pid) === null ? [FOREIGN] : []),
    ],
    stat: (pid) => {
      if (pid !== FOREIGN) return realProcEnv.stat(pid)
      const fields = Array<string>(22).fill('0')
      fields[0] = 'S'
      fields[1] = '1'
      fields[2] = String(run.pid)
      fields[19] = '424242'
      return fields
    },
  }
  const spawned = spawnCli({
    ...baseOptions(['-e', 'process.exit(0)']),
    graceMs: 50,
    reapSlackMs: 100,
    procEnv: env,
    groupExists: () => 'exists',
    onMembers: (members) => recorded.push(...members.map((m) => m.pid)),
    signalGroup: () => 'unavailable',
    signalPid: (pid) => {
      signalled.push(pid)
      return 'unavailable'
    },
  })
  run.pid = spawned.pid
  const outcome = await spawned.done
  expect(recorded).not.toContain(FOREIGN)
  expect(signalled).not.toContain(FOREIGN)
  // Not proven gone: the record stays and the agent is fenced.
  expect(outcome.groupGone).toBe(false)
}, 30_000)

test('N5: an empty listing never overrides the kernel: while it says the group exists, the group is not gone', async () => {
  const run = spawnCli({
    ...baseOptions(['-e', 'process.exit(0)']),
    graceMs: 50,
    reapSlackMs: 200,
    // Every process of the group has really ended; only the (faked) kernel answer says one is left.
    groupExists: () => 'exists',
  })
  const outcome = await run.done
  expect(outcome.groupGone).toBe(false)
}, 30_000)

test.each(['mismatch', 'unavailable'] as const)(
  'AA4: a %s pidfd answer sends no numeric signal and the run ends with the group unconfirmed',
  async (verdict) => {
    const sleeper = join(dir, 'aa4-sleeper.mjs')
    writeFileSync(sleeper, 'setInterval(() => {}, 1000)\n')
    const groupCalls: string[] = []
    const kill = vi.spyOn(process, 'kill')
    const run = spawnCli({
      ...baseOptions([sleeper]),
      graceMs: 50,
      reapSlackMs: 100,
      signalGroup: (_leader, _start, name) => {
        groupCalls.push(name)
        return verdict
      },
      signalPid: () => verdict,
    })
    const pid = run.pid!
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      run.stop('user')
      const outcome = await run.done
      expect(groupCalls).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
      // Nothing signalled by number: the sleeper is still up and the run says so.
      expect(
        kill.mock.calls.filter(([target, sig]) => (target === pid || target === -pid) && sig !== 0),
      ).toEqual([])
      expect(outcome.groupGone).toBe(false)
      expect(alive(pid)).toBe(true)
    } finally {
      kill.mockRestore()
      if (alive(pid)) process.kill(-pid, 'SIGKILL')
    }
  },
  30_000,
)

// ---- FZ1 (re-review 2026-10-12 #5, #9, #17) --------------------------------------------------------------------------

const script = (code: string) => baseOptions(['-e', code])

test('#9: a final stdout line with no newline is no record: the stream is incomplete and nothing parses it', async () => {
  const lines: string[] = []
  const run = spawnCli({
    ...script(`process.stdout.write('{"ok":1}\\n{"result":"success"}')`),
    parser: {
      parse: (line: string) => {
        lines.push(line)
        return []
      },
      stats: { unknown: 0, malformed: 0 },
    },
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.exitCode).toBe(0)
  expect(lines).toEqual(['{"ok":1}'])
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('partial-last-line')
}, 30_000)

test('#9: an oversized record is a dropped record and the stream is incomplete', async () => {
  const run = spawnCli({
    ...script(`process.stdout.write('x'.repeat(1100 * 1024) + '\\n{"a":1}\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('dropped-record')
}, 30_000)

test('#9: a clean stream is complete', async () => {
  const run = spawnCli({
    ...script(`process.stdout.write('{"a":1}\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome).toMatchObject({ streamComplete: true, streamLoss: [] })
}, 30_000)

test('#5: stderr keeps its start and is redacted whole: a labelled long value never leaks', async () => {
  const run = spawnCli({
    ...script(`process.stderr.write('password=' + 'v'.repeat(10000) + '\\n')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.stderr).not.toMatch(/v{20}/)
}, 30_000)

test('#5: stderr past the raw limit is dropped, not kept as a tail', async () => {
  const run = spawnCli({
    ...script(`process.stderr.write('head ' + 'a'.repeat(200000) + ' TAILMARK')`),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.stderr.startsWith('head ')).toBe(true)
  expect(outcome.stderr).not.toContain('TAILMARK')
}, 30_000)

test('#17: every stop path calls the hook once, with its cause, before the group is signalled', async () => {
  const cases = [
    ['user', 'user'],
    ['shutdown', 'score-shutdown'],
    ['timeout', 'deadline'],
    ['output_limit', 'output-cap'],
  ] as const
  for (const [reason, cause] of cases) {
    const causes: string[] = []
    const firstSignalSawCauses: number[] = []
    const output =
      reason === 'output_limit'
        ? `const l = 'x'.repeat(500 * 1024) + '\\n'; for (let i = 0; i < 90; i++) process.stdout.write(l); setInterval(() => {}, 1000)`
        : `setInterval(() => {}, 1000)`
    const run = spawnCli({
      ...script(output),
      ...(reason === 'timeout' ? { maxMs: 300 } : {}),
      graceMs: 200,
      onStop: (c) => causes.push(c),
      signalGroup: (pid, start, name) => {
        firstSignalSawCauses.push(causes.length)
        return realSignalGroup(pid, start, name)
      },
      onEvent: async () => undefined,
    })
    if (reason === 'user' || reason === 'shutdown') {
      // Asked twice: still recorded once.
      run.stop(reason)
      run.stop(reason)
    }
    const outcome = await run.done
    expect(outcome.stopped).toBe(reason)
    expect(causes).toEqual([cause])
    expect(firstSignalSawCauses[0]).toBe(1)
  }
}, 120_000)

test('#17: a hook that throws is reported and the stop still goes on', async () => {
  const errors: unknown[] = []
  const run = spawnCli({
    ...script(`setInterval(() => {}, 1000)`),
    graceMs: 200,
    onStop: () => {
      throw new Error('journal down')
    },
    onStopError: (error) => errors.push(error),
    onEvent: async () => undefined,
  })
  run.stop('user')
  const outcome = await run.done
  expect(outcome.stopped).toBe('user')
  expect(outcome.groupGone).toBe(true)
  expect(errors).toHaveLength(1)
}, 60_000)

test('FW #7: a pipe destroyed because a descendant outside the group holds it open is forced loss, not a complete stream', async () => {
  const run = spawnCli({
    ...script(
      // A descendant in its own session keeps stdout open past the turn, then ends by itself.
      `const { spawn } = require('node:child_process');
       const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] });
       holder.unref();
       process.stdout.write('{"result":"success"}\\n')`,
    ),
    onEvent: async () => undefined,
  })
  const outcome = await run.done
  expect(outcome.exitCode).toBe(0)
  expect(outcome.streamComplete).toBe(false)
  expect(outcome.streamLoss).toContain('forced-stdout-close')
}, 30_000)

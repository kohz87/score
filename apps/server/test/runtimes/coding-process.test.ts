import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { spawnCli } from '../../src/runtimes/coding/process.ts'

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
  const run = spawnCli({
    file: process.execPath,
    args: [leader],
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '' },
    stdin: '',
    parser: { parse: () => [], stats: { unknown: 0, malformed: 0 } },
    onEvent: async () => undefined,
    graceMs: 150,
  })
  await vi.waitFor(
    () => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8')).toBeTruthy(),
    {
      timeout: 30_000,
    },
  )
  const descendantPid = Number(readFileSync(pidFile, 'utf8'))
  expect(alive(descendantPid)).toBe(true)
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

/** A leader that starts a harmless worker (its pid goes to a file) and exits at once; `stdio` is the worker's. */
function leaderAndWorker(stdio: 'inherit' | 'ignore') {
  const pidFile = join(dir, `worker-${stdio}.pid`)
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
// Leave only once the worker is really running.
const wait = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(0) }, 10)
`,
  )
  return { leader, pidFile }
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

test.each(['inherit', 'ignore'] as const)(
  'S2-005: the wall-clock limit stops a worker that outlives its leader (worker stdio %s)',
  async (stdio) => {
    const { leader, pidFile } = leaderAndWorker(stdio)
    const run = spawnCli({
      ...baseOptions([leader]),
      maxMs: 400,
      graceMs: 3_000,
    })
    const pid = await workerPid(pidFile)
    try {
      const outcome = await run.done
      expect(outcome.stopped).toBe('timeout')
      expect(outcome.groupGone).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  },
  60_000,
)

test.each(['inherit', 'ignore'] as const)(
  'S2-005: Stop reaches a worker after its leader has exited (worker stdio %s)',
  async (stdio) => {
    const { leader, pidFile } = leaderAndWorker(stdio)
    const run = spawnCli({ ...baseOptions([leader]), graceMs: 3_000 })
    const pid = await workerPid(pidFile)
    // The leader is gone; the worker is not.
    await new Promise((r) => setTimeout(r, 300))
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
  const { leader, pidFile } = leaderAndWorker('ignore')
  const started = Date.now()
  const run = spawnCli({ ...baseOptions([leader]), graceMs: 500 })
  const pid = await workerPid(pidFile)
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
  const { leader, pidFile } = leaderAndWorker('ignore')
  const reported: { pid: number; startTime: string }[] = []
  const run = spawnCli({
    ...baseOptions([leader]),
    graceMs: 300,
    onMembers: (members) => reported.push(...members),
  })
  const pid = await workerPid(pidFile)
  try {
    await run.done
    expect(reported.map((member) => member.pid)).toContain(pid)
    expect(reported.every((member) => member.startTime.length > 0)).toBe(true)
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}, 60_000)

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

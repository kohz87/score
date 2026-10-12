import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetPdeathsigSupport } from '../../src/runtimes/coding/pdeathsig-exec.ts'
import { spawnCli, SpawnRecordError } from '../../src/runtimes/coding/process.ts'

// Z3 (7.7a v4 review #5): the fallback's CLI dies with Score, and is recorded before it gets its prompt.

const parentScript = fileURLToPath(new URL('../helpers/pdeathsig-parent.ts', import.meta.url))
let dir: string
const killAtEnd: number[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-pdeathsig-'))
})
afterEach(() => {
  for (const pid of killAtEnd.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const parser = { parse: () => [], stats: { unknown: 0, malformed: 0 } }
const base = {
  file: process.execPath,
  cwd: process.cwd(),
  env: { PATH: process.env['PATH'] ?? '' },
  parser,
  onEvent: async () => undefined,
}

test('when the Score-like parent is killed, the wrapped CLI dies with it', async () => {
  const pidFile = join(dir, 'cli.pid')
  const ready = join(dir, 'ready')
  const parent = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', parentScript, pidFile, ready],
    { stdio: 'ignore' },
  )
  killAtEnd.push(parent.pid!)
  await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 30_000 })
  const cli = Number(readFileSync(pidFile, 'utf8'))
  killAtEnd.push(cli)
  expect(alive(cli)).toBe(true)
  const closed = new Promise((resolve) => parent.on('close', resolve))
  process.kill(parent.pid!, 'SIGKILL')
  await closed
  // The kernel kills the CLI as its parent dies; nothing of Score is left to do it.
  await vi.waitFor(
    () => {
      // A zombie (waiting for init to reap it) is gone as far as running work goes.
      let stat: string
      try {
        stat = readFileSync(`/proc/${cli}/stat`, 'utf8')
      } catch {
        return
      }
      expect(stat.split(') ')[1]!.split(' ')[0]).toBe('Z')
    },
    { timeout: 10_000 },
  )
})

test('the CLI is not executed, and gets no prompt, until onSpawn has returned', async () => {
  const ran = join(dir, 'ran')
  const got = join(dir, 'got')
  const script = join(dir, 'cli.mjs')
  writeFileSync(
    script,
    `import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(ran)}, 'x')
let data = ''
process.stdin.on('data', (c) => (data += c))
process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(got)}, data); process.exit(0) })
`,
  )
  let ranDuringRecord: boolean | undefined
  let gotDuringRecord: boolean | undefined
  const run = spawnCli({
    ...base,
    args: [script],
    stdin: 'the prompt',
    onSpawn: () => {
      // Recording takes a while (a durable write); the CLI must not have started or been given its prompt meanwhile.
      const end = Date.now() + 800
      while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      ranDuringRecord = existsSync(ran)
      gotDuringRecord = existsSync(got)
    },
  })
  const outcome = await run.done
  expect(ranDuringRecord).toBe(false)
  expect(gotDuringRecord).toBe(false)
  expect(outcome.exitCode).toBe(0)
  expect(readFileSync(got, 'utf8')).toBe('the prompt')
})

test('when recording the process fails, the CLI never runs and never receives its prompt', async () => {
  const ran = join(dir, 'ran')
  const script = join(dir, 'cli.mjs')
  writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(ran)}, 'x')\n`)
  let error: unknown
  try {
    spawnCli({
      ...base,
      args: [script],
      stdin: 'the prompt',
      onSpawn: () => {
        throw new Error('disk full')
      },
    })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(SpawnRecordError)
  await (error as SpawnRecordError).terminated
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(existsSync(ran)).toBe(false)
})

test('without a usable python the CLI is not started at all, with a clear message', async () => {
  const ran = join(dir, 'ran')
  const script = join(dir, 'cli.mjs')
  writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(ran)}, 'x')\n`)
  const before = process.env['SCORE_PYTHON']
  process.env['SCORE_PYTHON'] = join(dir, 'no-such-python')
  resetPdeathsigSupport()
  try {
    const run = spawnCli({ ...base, args: [script], stdin: '' })
    const outcome = await run.done
    expect(run.pid).toBeUndefined()
    expect(outcome.spawnError).toBe('python_unavailable')
    expect(outcome.stderr).toMatch(/Python 3/)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(ran)).toBe(false)
  } finally {
    if (before === undefined) delete process.env['SCORE_PYTHON']
    else process.env['SCORE_PYTHON'] = before
    resetPdeathsigSupport()
  }
})

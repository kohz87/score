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
      timeout: 10_000,
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
}, 20_000)

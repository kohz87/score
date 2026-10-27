// 3.13: the oracle's real process runner (no shell, own process group, clean environment, kept tail, timeout).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { makeCheckSpawner, type CheckProcess } from '../../src/runtimes/check/spawn-check.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'score-check-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const spawner = () => makeCheckSpawner(defaultRootPolicy())
const node = process.execPath
async function run(argv: string[], timeoutMs = 20_000, keepBytes = 64 * 1024) {
  const proc = (await spawner()({ argv, cwd: dir, timeoutMs, keepBytes })) as CheckProcess
  expect('done' in proc).toBe(true)
  return proc
}

test('passes the exit code and output, runs in the folder, with a clean environment', async () => {
  process.env.SCORE_SECRET_TEST = 'leak'
  const proc = await run([
    node,
    '-e',
    'console.log(process.cwd()); console.log(process.env.SCORE_SECRET_TEST ?? "none"); console.log(process.env.CI); console.error("err"); process.exit(3)',
  ])
  const result = await proc.done
  delete process.env.SCORE_SECRET_TEST
  expect(result.exitCode).toBe(3)
  expect(result.output).toContain(dir)
  expect(result.output).toContain('none')
  expect(result.output).toContain('1')
  expect(result.output).toContain('err')
})

test('arguments reach the program literally: no shell expands them', async () => {
  const result = await (
    await run([node, '-e', 'console.log(process.argv.slice(1).join("|"))', '$HOME', '*', 'a;b'])
  ).done
  expect(result.output.trim()).toBe('$HOME|*|a;b')
})

test('a timeout kills the whole process group', async () => {
  const started = Date.now()
  const proc = await run(
    [
      node,
      '-e',
      'require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {stdio: "inherit"}); setTimeout(()=>{}, 60000)',
    ],
    500,
  )
  const result = await proc.done
  expect(result.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(10_000)
})

test('a process that left the group and holds the pipes does not keep the check open', async () => {
  const started = Date.now()
  const result = await (
    await run([
      node,
      '-e',
      'require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], {detached: true, stdio: "inherit"}).unref(); console.log("leader done")',
    ])
  ).done
  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('leader done')
  expect(Date.now() - started).toBeLessThan(8_000)
})

test('stop ends it and says so', async () => {
  const proc = await run([node, '-e', 'setTimeout(()=>{}, 60000)'])
  setTimeout(() => proc.stop(), 100)
  const result = await proc.done
  expect(result.stopped).toBe(true)
})

test('keeps only the end of a long output', async () => {
  const result = await (
    await run([node, '-e', 'process.stdout.write("a".repeat(50000) + "THE END")'], 20_000, 1024)
  ).done
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024)
  expect(result.output.endsWith('THE END')).toBe(true)
})

test('a missing program is reported, not thrown', async () => {
  const result = await (await run(['score-no-such-program-xyz'])).done
  expect(result.exitCode).toBeNull()
  expect(result.output).toMatch(/no such program/)
})

test('a folder the workspace rules refuse is not run', async () => {
  const proc = await spawner()({
    argv: [node, '-e', '1'],
    cwd: homedir(),
    timeoutMs: 1000,
    keepBytes: 1024,
  })
  expect(proc).toMatchObject({ refused: expect.stringMatching(/home folder/) })
})

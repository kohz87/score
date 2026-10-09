import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const index = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const children: ChildProcess[] = []
const homes: string[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function start(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'score-index-'))
  homes.push(home)
  const child = spawn(process.execPath, ['--import', 'tsx', index], {
    cwd,
    env: { PATH: process.env.PATH!, HOME: home, SCORE_HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const until = async (pattern: RegExp) => {
    for (let i = 0; i < 300 && !pattern.test(output); i++) {
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(output).toMatch(pattern)
  }
  return { home, child, until, output: () => output }
}

test('guide-only mode survives SIGUSR2 (scripts/score pair)', async () => {
  const port = await freePort()
  const run = start({
    SCORE_REMOTE: '1',
    SCORE_HOST: '127.0.0.1',
    SCORE_PORT: String(port),
    SCORE_PUBLIC_ORIGINS: `https://127.0.0.1:${port}`,
    SCORE_MODE: 'fake',
  })
  await run.until(/Setup guide:/)
  run.child.kill('SIGUSR2')
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(run.child.exitCode).toBeNull()
  expect(run.child.signalCode).toBeNull()
}, 40_000)

test('a non-terminal stdout never receives the startup pairing link; it goes to a 0600 file', async () => {
  const port = await freePort()
  const run = start({ SCORE_PORT: String(port), SCORE_MODE: 'fake' })
  await run.until(/Pair this browser/)
  expect(run.output()).not.toMatch(/pair#/)
  const file = join(run.home, 'pair-link')
  expect(existsSync(file)).toBe(true)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readFileSync(file, 'utf8')).toMatch(/\/pair#[A-Za-z0-9_-]{20,}/)
}, 40_000)

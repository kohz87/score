import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'

export let dir: string

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function setupProcessTestLifecycle() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'score-coding-proc-'))
  })
  afterEach(() => {
    // A test that fails before its own cleanup (a wait that times out under load) must not leave its worker running:
    // the 'ignore' worker has no pipe to its parent, so nothing else ever reaps it. Every worker writes its pid here.
    for (const name of readdirSync(dir)) {
      if (!/^worker-.*\.pid$/.test(name)) continue
      const pid = Number(readFileSync(join(dir, name), 'utf8'))
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  })
}

const noParser = { parse: () => [], stats: { unknown: 0, malformed: 0 } }

export const baseOptions = (args: string[]) => ({
  file: process.execPath,
  args,
  cwd: tmpdir(),
  env: { PATH: process.env['PATH'] ?? '' },
  stdin: '',
  parser: noParser,
  onEvent: async () => undefined,
})

export const script = (code: string) => baseOptions(['-e', code])

export const waitGone = async (pid: number) => {
  await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000 })
}

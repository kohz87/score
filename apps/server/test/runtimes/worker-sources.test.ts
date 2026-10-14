import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// An `openSync` spy: the Git-pointer reader must never open a CLI configuration file, even through a link (F2 #2).
const opened = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    openSync: ((path: import('node:fs').PathLike, ...rest: unknown[]) => {
      opened.push(String(path))
      return (real.openSync as (...args: unknown[]) => number)(path, ...rest)
    }) as typeof real.openSync,
  }
})

const { mainCheckoutOf, PolicyUnverifiable } =
  await import('../../src/runtimes/coding/worker-sources.ts')

let dir: string
let workspace: string
beforeEach(() => {
  opened.length = 0
  dir = mkdtempSync(join(tmpdir(), 'score-test-ws-'))
  workspace = join(dir, 'ws')
  mkdirSync(workspace)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function worktree(): { main: string; gitDir: string } {
  const main = join(dir, 'main')
  const gitDir = join(main, '.git', 'worktrees', 'wt')
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(workspace, '.git'), `gitdir: ${gitDir}\n`)
  return { main, gitDir }
}

describe('Git pointer reads (F2 #2)', () => {
  test('a linked worktree resolves to its main checkout', () => {
    const { gitDir, main } = worktree()
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    expect(mainCheckoutOf(workspace)).toBe(main)
  })

  test('a symlinked commondir is refused and its target (a CLI config file) is never opened', () => {
    const { gitDir } = worktree()
    const config = join(dir, 'config.toml')
    writeFileSync(config, '../..\n')
    chmodSync(config, 0o000)
    symlinkSync(config, join(gitDir, 'commondir'))
    expect(() => mainCheckoutOf(workspace)).toThrow(PolicyUnverifiable)
    expect(
      opened.filter((path) => path.includes('config.toml') || path.endsWith('commondir')),
    ).toEqual([])
  })

  test('a symlinked commondir to a readable file is refused too (old code returned the main checkout)', () => {
    const { gitDir } = worktree()
    const target = join(dir, 'elsewhere')
    writeFileSync(target, '../..\n')
    symlinkSync(target, join(gitDir, 'commondir'))
    expect(() => mainCheckoutOf(workspace)).toThrow(PolicyUnverifiable)
  })

  test('a gitdir that does not exist is unverifiable', () => {
    writeFileSync(join(workspace, '.git'), 'gitdir: /missing/.git\n')
    expect(() => mainCheckoutOf(workspace)).toThrow(PolicyUnverifiable)
  })

  test('a gitdir without HEAD is unverifiable', () => {
    const { gitDir } = worktree()
    rmSync(join(gitDir, 'HEAD'))
    expect(() => mainCheckoutOf(workspace)).toThrow(PolicyUnverifiable)
  })
})

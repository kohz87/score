import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { claudeDriver } from '../../src/runtimes/coding/claude.ts'
import { codexDriver } from '../../src/runtimes/coding/codex.ts'
import { PolicyUnverifiable, mainCheckoutOf } from '../../src/runtimes/coding/worker-sources.ts'
import { workerHarness, type WorkerHarness } from '../helpers/worker-harness.ts'
import { oneStep, useWorkerHarness } from './coding-workers-helpers.ts'

// 7.7b-F1: regression tests for the code review of 2026-10-14 (docs/reviews/2026-10-14-7.7b-code-review.md). Each test
// is that review's probe, written to fail on the code the review found.

let h: WorkerHarness
useWorkerHarness(
  () => h,
  () => {
    h = undefined as never
  },
)

describe('#2 configuration outside the workspace ancestors (a Git worktree)', () => {
  /** `<h.workspace>` becomes a linked worktree of a main checkout somewhere else. Returns the main checkout. */
  function makeWorktree(): string {
    const main = join(h.dir, 'main-checkout')
    const gitDir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(h.workspace, '.git'), `gitdir: ${gitDir}\n`)
    return main
  }

  test('the main checkout of a linked worktree is found from Git metadata alone', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    const main = makeWorktree()
    expect(mainCheckoutOf(h.workspace)).toBe(main)
    const context = { home: h.home, workspace: h.workspace, env: {} }
    for (const driver of [claudeDriver, codexDriver]) {
      const bound = driver.worker!.bound(context)
      expect(bound.some((path) => path.startsWith(main + '/'))).toBe(true)
    }
    expect(claudeDriver.worker!.bound(context)).toContain(
      join(main, '.claude', 'settings.local.json'),
    )
    expect(codexDriver.worker!.bound(context)).toContain(join(main, '.codex', 'config.toml'))
  })

  test('changing the main checkout’s settings.local.json changes the policy id (stat only: unreadable contents are fine)', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    const main = makeWorktree()
    const idOf = async () => (await h.orch.preflight('lead', ['coder'])).workers[0]!.policyId
    const before = await idOf()
    mkdirSync(join(main, '.claude'), { recursive: true })
    const file = join(main, '.claude', 'settings.local.json')
    writeFileSync(file, '{"permissions":{"allow":["Bash"]}}')
    // Nothing may open the file: it has no permission bits at all.
    chmodSync(file, 0)
    const after = await idOf()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })

  test('a worktree whose main checkout can’t be located is unverifiable, never silently ignored', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    h.addAgent()
    writeFileSync(join(h.workspace, '.git'), 'not a pointer\n')
    expect(() => mainCheckoutOf(h.workspace)).toThrow(PolicyUnverifiable)
    const entry = (await h.orch.preflight('lead', ['coder'])).workers[0]!
    expect(entry.readiness).toBe('reach_unverifiable')
  })

  test('an ordinary checkout has no extra location', async () => {
    h = await workerHarness({ lead: { script: oneStep() } })
    mkdirSync(join(h.workspace, '.git'))
    expect(mainCheckoutOf(h.workspace)).toBeUndefined()
  })
})

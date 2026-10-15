import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { VaultGit } from '../../src/knowledge/git.ts'

// Audit 4 follow-up: the ignored-note check asks git once per batch, not once per path (a 1,000-note import took three
// times as long), and still answers exactly per path.
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function repo(): Promise<{ dir: string; git: VaultGit }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-test-ignore-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '.gitignore'), 'drafts/\n')
  fs.mkdirSync(path.join(dir, 'drafts'))
  const git = new VaultGit(dir)
  await git.init(true)
  return { dir, git }
}

test('one git run answers a whole batch: only the ignored, untracked paths come back', async () => {
  const { dir, git } = await repo()
  const paths = Array.from({ length: 600 }, (_, i) => `n${i}.md`)
  paths.push('drafts/a.md', 'drafts/b.md')
  for (const rel of paths) fs.writeFileSync(path.join(dir, rel), 'x')
  const traceFile = path.join(dir, '..', `${path.basename(dir)}.trace`)
  dirs.push(traceFile)
  process.env.GIT_TRACE = traceFile
  try {
    expect([...(await git.ignoredUntracked(paths))].sort()).toEqual(['drafts/a.md', 'drafts/b.md'])
  } finally {
    delete process.env.GIT_TRACE
  }
  const runs = fs.readFileSync(traceFile, 'utf8').match(/built-in: git check-ignore/g) ?? []
  // 602 paths in batches of 500: two runs, never one per path.
  expect(runs.length).toBeLessThanOrEqual(2)
})

test('a path git would quote is still answered exactly, and a batch with none ignored is empty', async () => {
  const { dir, git } = await repo()
  fs.writeFileSync(path.join(dir, 'drafts', 'say "hi".md'), 'x')
  fs.writeFileSync(path.join(dir, 'plain.md'), 'x')
  expect([...(await git.ignoredUntracked(['drafts/say "hi".md', 'plain.md']))]).toEqual([
    'drafts/say "hi".md',
  ])
  expect((await git.ignoredUntracked(['plain.md'])).size).toBe(0)
})

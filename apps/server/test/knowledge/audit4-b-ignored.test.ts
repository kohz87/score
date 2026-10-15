import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
const scratch: string[] = []
const restoreEnv: Array<() => void> = []
afterEach(async () => {
  await h?.cleanup()
  h = undefined
  for (const undo of restoreEnv.splice(0)) undo()
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

describe('S4-003 a note in an ignored, untracked path is saved but not kept in history', () => {
  test('a newly ignored folder: the note saves, says so, and git is never forced', async () => {
    const warnings: string[] = []
    h = await makeVault({
      files: { '.gitignore': 'private/\n', 'a.md': 'x' },
      log: { warn: (_o, message) => void warnings.push(message) },
    })
    const result = await h.vault.writeNote('private/secret.md', { body: '# Secret', etag: null })
    expect(result).toMatchObject({ versioned: false, historyUpdated: true })
    expect(fs.readFileSync(path.join(h.vaultDir, 'private', 'secret.md'), 'utf8')).toBe('# Secret')
    expect((await h.vault.readNote('private/secret.md')).versioned).toBe(false)
    expect(await h.vault.history('private/secret.md')).toEqual([])
    expect(gitIn(h.vaultDir, 'ls-files')).not.toContain('secret.md')
    expect(warnings).toEqual([])
    // A second save and a delete work the same way.
    const again = await h.vault.writeNote('private/secret.md', {
      body: '# Secret 2',
      etag: result.etag,
    })
    expect(again.versioned).toBe(false)
    await h.vault.deleteNote('private/secret.md')
    expect(fs.existsSync(path.join(h.vaultDir, 'private', 'secret.md'))).toBe(false)
    expect(warnings).toEqual([])
    // A normal note is unaffected.
    const normal = await h.vault.writeNote('b.md', { body: 'b', etag: null })
    expect(normal).toMatchObject({ versioned: true, historyUpdated: true })
    expect((await h.vault.history('b.md')).length).toBe(1)
  })

  test('a globally ignored path (core.excludesFile) counts too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-a4b-'))
    scratch.push(dir)
    fs.writeFileSync(path.join(dir, 'ignore'), 'scratch/\n')
    fs.writeFileSync(path.join(dir, 'gitconfig'), `[core]\n\texcludesFile = ${dir}/ignore\n`)
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig')
    restoreEnv.push(() => {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    })
    h = await makeVault({ files: { 'a.md': 'x' } })
    const result = await h.vault.writeNote('scratch/n.md', { body: 'n', etag: null })
    expect(result.versioned).toBe(false)
    expect(fs.existsSync(path.join(h.vaultDir, 'scratch', 'n.md'))).toBe(true)
    expect(gitIn(h.vaultDir, 'ls-files')).not.toContain('n.md')
  })

  test('a tracked note that later matches an ignore rule keeps its history', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    const first = await h.vault.writeNote('keep/n.md', { body: 'one', etag: null })
    expect(first.versioned).toBe(true)
    fs.writeFileSync(path.join(h.vaultDir, '.gitignore'), 'keep/\n')
    const second = await h.vault.writeNote('keep/n.md', { body: 'two', etag: first.etag })
    expect(second).toMatchObject({ versioned: true, historyUpdated: true })
    expect((await h.vault.readNote('keep/n.md')).versioned).toBe(true)
    expect((await h.vault.history('keep/n.md')).length).toBe(2)
    expect(gitOut(h.vaultDir, 'ls-files')).toContain('keep/n.md')
  })

  test('an outside edit to a tracked note in a newly ignored folder is still recorded', async () => {
    h = await makeVault({ files: { 'a.md': 'x', 'keep/n.md': 'one' } })
    fs.writeFileSync(path.join(h.vaultDir, '.gitignore'), 'keep/\n')
    fs.writeFileSync(path.join(h.vaultDir, 'keep', 'n.md'), 'edited outside')
    const result = await h.vault.writeNote('other.md', { body: 'o', etag: null })
    expect(result).toMatchObject({ versioned: true, historyUpdated: true })
    expect(gitOut(h.vaultDir, 'log', '--format=%s', '--', 'keep/n.md')).toContain('Outside changes')
  })

  test('another commit failure is reported, not swallowed', async () => {
    const warnings: string[] = []
    h = await makeVault({
      files: { 'a.md': 'x' },
      log: { warn: (_o, message) => void warnings.push(message) },
    })
    fs.writeFileSync(path.join(h.vaultDir, '.git', 'index.lock'), '')
    const result = await h.vault.writeNote('n.md', { body: 'n', etag: null })
    fs.rmSync(path.join(h.vaultDir, '.git', 'index.lock'))
    expect(result).toMatchObject({ versioned: true, historyUpdated: false })
    expect(fs.readFileSync(path.join(h.vaultDir, 'n.md'), 'utf8')).toBe('n')
    expect(warnings).toContain('Could not commit a knowledge change')
  })
})

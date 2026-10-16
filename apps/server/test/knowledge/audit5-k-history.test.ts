import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
const undo: Array<() => void> = []
afterEach(async () => {
  await h?.cleanup()
  h = undefined
  for (const fn of undo.splice(0)) fn()
})

describe('S5-003 / S5-004 history status of a note save', () => {
  const noGit = async (files?: Record<string, string>) => {
    const before = process.env.PATH
    process.env.PATH = path.join(os.tmpdir(), 'score-no-git-here')
    try {
      h = await makeVault(files ? { files } : {})
    } finally {
      process.env.PATH = before
    }
  }

  test('no git: saved, but never reported as versioned or updated (twice)', async () => {
    await noGit()
    const first = await h!.vault.writeNote('a.md', { body: 'one', etag: null })
    expect(first).toMatchObject({
      history: 'git_unavailable',
      versioned: false,
      historyUpdated: false,
    })
    const again = await h!.vault.writeNote('a.md', { body: 'one', etag: first.etag })
    expect(again).toMatchObject({
      history: 'git_unavailable',
      versioned: false,
      historyUpdated: false,
    })
    expect(fs.readFileSync(path.join(h!.vaultDir, 'a.md'), 'utf8')).toBe('one')
  })

  test('a broken repository is the same: saved, history not updated', async () => {
    h = await makeVault({ files: { '.git/HEAD': 'not a ref\n' } })
    expect(h.vault.gitAvailable).toBe(false)
    const first = await h.vault.writeNote('a.md', { body: 'one', etag: null })
    expect(first.history).toBe('git_unavailable')
    const second = await h.vault.writeNote('a.md', { body: 'two', etag: first.etag })
    expect(second).toMatchObject({ history: 'git_unavailable', historyUpdated: false })
  })

  test('a commit that failed is repaired by saving the same content again', async () => {
    const warnings: string[] = []
    h = await makeVault({ log: { warn: (_o, message) => void warnings.push(message) } })
    const first = await h.vault.writeNote('a.md', { body: 'one', etag: null })
    expect(first.history).toBe('committed')
    const lock = path.join(h.vaultDir, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    const failed = await h.vault.writeNote('a.md', { body: 'two', etag: first.etag })
    expect(failed).toMatchObject({ history: 'failed', historyUpdated: false, versioned: true })
    expect(warnings.length).toBeGreaterThan(0)
    const commitsBefore = Number(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD'))
    expect(gitOut(h.vaultDir, 'show', 'HEAD:a.md')).toBe('one')

    // Still failing: an identical save reports it again instead of claiming success.
    const still = await h.vault.writeNote('a.md', { body: 'two', etag: failed.etag })
    expect(still).toMatchObject({ history: 'failed', historyUpdated: false })

    fs.rmSync(lock)
    const repaired = await h.vault.writeNote('a.md', { body: 'two', etag: failed.etag })
    expect(repaired).toMatchObject({ history: 'committed', historyUpdated: true, versioned: true })
    expect(Number(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
    expect(gitOut(h.vaultDir, 'show', 'HEAD:a.md')).toBe('two')
    expect((await h.vault.history('a.md')).length).toBe(2)

    // Once recorded, the same save is a no-op that says so.
    const noop = await h.vault.writeNote('a.md', { body: 'two', etag: repaired.etag })
    expect(noop).toMatchObject({ history: 'unchanged', historyUpdated: true, versioned: true })
    expect(Number(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
  })

  test('an ignored path is not_versioned, also on a no-op save', async () => {
    h = await makeVault({ files: { '.gitignore': 'private/\n' } })
    const first = await h.vault.writeNote('private/n.md', { body: 'x', etag: null })
    expect(first).toMatchObject({
      history: 'not_versioned',
      versioned: false,
      historyUpdated: true,
    })
    const noop = await h.vault.writeNote('private/n.md', { body: 'x', etag: first.etag })
    expect(noop.history).toBe('not_versioned')
  })
})

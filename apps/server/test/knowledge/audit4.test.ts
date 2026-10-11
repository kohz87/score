import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MAX_NOTE_BYTES } from '../../src/knowledge/note.ts'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
})

describe('snapshot failures never allow an unrecoverable overwrite or delete', () => {
  test('with a stale index lock, deleting or moving a note with outside edits is refused and nothing is lost', async () => {
    h = await makeVault()
    await h.vault.writeNote('a.md', { body: 'saved', etag: null })
    fs.writeFileSync(path.join(h.vaultDir, 'a.md'), 'outside edit, never committed')
    fs.writeFileSync(path.join(h.vaultDir, '.git', 'index.lock'), '')
    await expect(h.vault.deleteNote('a.md')).rejects.toMatchObject({ status: 503 })
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({ status: 503 })
    await expect(h.vault.restoreNote('a.md', 'HEAD')).rejects.toBeTruthy()
    expect(fs.readFileSync(path.join(h.vaultDir, 'a.md'), 'utf8')).toBe(
      'outside edit, never committed',
    )
    fs.rmSync(path.join(h.vaultDir, '.git', 'index.lock'))
    await h.vault.deleteNote('a.md')
    // Once git works again the outside version is in history.
    expect(gitOut(h.vaultDir, 'log', '--all', '-p', '--format=%s')).toContain(
      'outside edit, never committed',
    )
  })

  test('an outside edit that lands while Score saves the same note is committed first and the save is refused', async () => {
    h = await makeVault()
    const created = await h.vault.writeNote('a.md', { body: 'v1', etag: null })
    const original = h.vault.git.commitOutsideChanges.bind(h.vault.git)
    vi.spyOn(h.vault.git, 'commitOutsideChanges').mockImplementation(async () => {
      fs.writeFileSync(path.join(h.vaultDir, 'a.md'), 'outside v2')
      return original()
    })
    await expect(
      h.vault.writeNote('a.md', { body: 'mine', etag: created.etag }),
    ).rejects.toMatchObject({ status: 412 })
    expect(fs.readFileSync(path.join(h.vaultDir, 'a.md'), 'utf8')).toBe('outside v2')
    expect(gitOut(h.vaultDir, 'log', '-p', '--format=%s')).toContain('outside v2')
  })
})

describe('vault contents', () => {
  test('the scanner does not index a file reached through a folder swapped for a symlink mid-scan', async () => {
    h = await makeVault({ files: { 'sub/a.md': 'inside' } })
    const outside = path.join(h.dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'a.md'), 'SECRET outside the vault')
    fs.writeFileSync(path.join(h.vaultDir, 'sub', 'a.md'), 'changed inside so it is re-read')
    const real = fs.promises.lstat
    let swapped = false
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
      const result = await real(...(args as Parameters<typeof real>))
      if (!swapped && String(args[0]).endsWith(path.join('sub', 'a.md'))) {
        swapped = true
        fs.renameSync(path.join(h.vaultDir, 'sub'), path.join(h.dir, 'sub-moved'))
        fs.symlinkSync(outside, path.join(h.vaultDir, 'sub'))
      }
      return result
    })
    await h.vault.scanNow()
    vi.restoreAllMocks()
    expect(swapped).toBe(true)
    const hits = h.vault.search('SECRET', 10)
    expect(hits).toEqual([])
  })

  test('link rewrites that would push a referring note over the size limit are refused before anything moves', async () => {
    h = await makeVault()
    await h.vault.writeNote('a.md', { body: 'target', etag: null })
    const link = '[[a]] '
    const body = link.repeat(Math.floor((MAX_NOTE_BYTES - 200) / link.length))
    await h.vault.writeNote('big.md', { body, etag: null })
    await expect(
      h.vault.moveNote('a.md', 'a-much-longer-name-for-the-target.md', true),
    ).rejects.toMatchObject({ status: 413 })
    expect(fs.existsSync(path.join(h.vaultDir, 'a.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.vaultDir, 'a-much-longer-name-for-the-target.md'))).toBe(false)
    await expect(h.vault.readNote('big.md')).resolves.toBeTruthy()
  }, 60_000)

  test('renaming a short, self-linking note keeps its earlier versions reachable', async () => {
    h = await makeVault()
    await h.vault.writeNote('Old.md', { body: '[[Old]]', etag: null })
    await h.vault.moveNote('Old.md', 'New.md', true)
    const versions = await h.vault.history('New.md')
    expect(versions.length).toBeGreaterThanOrEqual(2)
    const first = versions.at(-1)!
    expect((await h.vault.version('New.md', first.commit)).body).toBe('[[Old]]')
  })

  test('a filename with a quote has loadable versions', async () => {
    h = await makeVault()
    const first = await h.vault.writeNote('a"b.md', { body: 'one', etag: null })
    await h.vault.writeNote('a"b.md', { body: 'two', etag: first.etag })
    const versions = await h.vault.history('a"b.md')
    expect(versions.length).toBeGreaterThan(0)
    const loaded = await h.vault.version('a"b.md', versions.at(-1)!.commit)
    expect(loaded.body).toBe(versions.length === 1 ? 'two' : 'one')
  })

  test('a rename rewrites links that were added outside Score just before the watcher ran', async () => {
    h = await makeVault({ files: { 'Target.md': 'target' } })
    fs.writeFileSync(path.join(h.vaultDir, 'fresh.md'), 'points at [[Target]]')
    const moved = await h.vault.moveNote('Target.md', 'Renamed.md', true)
    expect(moved.updatedNotes).toBe(1)
    expect(fs.readFileSync(path.join(h.vaultDir, 'fresh.md'), 'utf8')).toBe('points at [[Renamed]]')
  })
})

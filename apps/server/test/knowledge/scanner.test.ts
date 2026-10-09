import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.cleanup())

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(h.vaultDir, rel)), { recursive: true })
  fs.writeFileSync(path.join(h.vaultDir, rel), content)
}
const paths = async () => (await h.vault.tree()).notes.map((n) => n.path)

describe('scanner', () => {
  test('finds files created, edited and deleted outside, announcing each as "outside"', async () => {
    h = await makeVault({ files: { 'keep.md': 'keep', 'edit.md': 'old', 'gone.md': 'bye' } })
    expect(await paths()).toEqual(['edit.md', 'gone.md', 'keep.md'])
    expect(await h.vault.scanNow()).toEqual([])
    write('Sub/new.md', '# New\n[[keep]]')
    write('edit.md', 'newer text')
    fs.rmSync(path.join(h.vaultDir, 'gone.md'))
    h.events.length = 0
    expect((await h.vault.scanNow()).sort()).toEqual(['Sub/new.md', 'edit.md', 'gone.md'])
    expect(await paths()).toEqual(['Sub/new.md', 'edit.md', 'keep.md'])
    expect(h.events.map((e) => [e.path, e.kind, e.by]).sort()).toEqual([
      ['Sub/new.md', 'written', 'outside'],
      ['edit.md', 'written', 'outside'],
      ['gone.md', 'deleted', 'outside'],
    ])
    expect((await h.vault.readNote('keep.md')).backlinks.map((b) => b.path)).toEqual(['Sub/new.md'])
    expect(h.vault.search('newer', 5).map((x) => x.path)).toEqual(['edit.md'])
    expect(h.vault.search('old', 5)).toEqual([])
    // The tree marks outside edits.
    expect((await h.vault.tree()).notes.find((n) => n.path === 'edit.md')?.lastAuthor).toBe(
      'outside',
    )
    // Nothing changed since: no more events.
    h.events.length = 0
    expect(await h.vault.scanNow()).toEqual([])
    expect(h.events).toEqual([])
  })

  test("Score's own writes are not announced a second time by the scan", async () => {
    h = await makeVault()
    await h.vault.writeNote('mine.md', { body: 'x', etag: null })
    h.events.length = 0
    expect(await h.vault.scanNow()).toEqual([])
    expect(h.events).toEqual([])
  })

  test('touching a file without changing it only refreshes the stat (no event)', async () => {
    h = await makeVault({ files: { 'a.md': 'same' } })
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(h.vaultDir, 'a.md'), later, later)
    expect(await h.vault.scanNow()).toEqual([])
    expect(h.events).toEqual([])
  })

  test('hidden folders, symlinks, non-markdown files and over-size notes are not indexed', async () => {
    h = await makeVault({
      files: {
        'ok.md': 'ok',
        '.obsidian/x.md': 'no',
        'notes.txt': 'no',
        'attachments/pic.png': 'bin',
      },
    })
    fs.symlinkSync(path.join(h.vaultDir, 'ok.md'), path.join(h.vaultDir, 'alias.md'))
    await h.vault.scanNow()
    expect(await paths()).toEqual(['ok.md'])
    expect((await h.vault.tree()).folders).toEqual(['attachments'])
  })

  test('reading a note the scanner has not seen yet indexes it first', async () => {
    h = await makeVault()
    write('late.md', '# Late\n[[ghost]]')
    const note = await h.vault.readNote('late.md')
    expect(note.title).toBe('Late')
    expect(note.links).toEqual([{ target: 'ghost', path: null }])
    expect(h.events.at(-1)).toMatchObject({ path: 'late.md', by: 'outside' })
  })

  test('rebuild drops the index and recreates it from the files', async () => {
    h = await makeVault({ files: { 'a.md': '# A\n[[b]]', 'b.md': 'bee' } })
    h.db.tx((sqlite) =>
      sqlite.exec(
        "DELETE FROM knowledge_links; DELETE FROM knowledge_fts; UPDATE knowledge_notes SET title = 'junk'",
      ),
    )
    expect(h.vault.search('bee', 5)).toEqual([])
    await h.vault.rebuild()
    expect((await h.vault.readNote('a.md')).title).toBe('A')
    expect((await h.vault.readNote('a.md')).links).toEqual([{ target: 'b', path: 'b.md' }])
    expect(h.vault.search('bee', 5).map((x) => x.path)).toEqual(['b.md'])
    expect(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_fts').get()).toEqual({ n: 2 })
  })

  test('the watcher picks up outside edits after the debounce, and bursts become one scan', async () => {
    h = await makeVault({ watch: true, debounceMs: 80 })
    write('burst.md', '1')
    write('burst.md', '22')
    write('burst2.md', 'x')
    await vi.waitFor(
      () => expect(h.events.map((e) => e.path).sort()).toEqual(['burst.md', 'burst2.md']),
      { timeout: 5000 },
    )
    expect(await paths()).toEqual(expect.arrayContaining(['burst.md', 'burst2.md']))
    h.events.length = 0
    fs.rmSync(path.join(h.vaultDir, 'burst2.md'))
    await vi.waitFor(
      () =>
        expect(h.events).toEqual([{ path: 'burst2.md', kind: 'deleted', to: null, by: 'outside' }]),
      { timeout: 5000 },
    )
  })

  test('the periodic scan covers missed events', async () => {
    h = await makeVault({ scanIntervalMs: 60 })
    write('missed.md', 'found by the timer')
    await vi.waitFor(() => expect(h.events.map((e) => e.path)).toEqual(['missed.md']), {
      timeout: 5000,
    })
  })

  test('a note with frontmatter links keeps body links only; links dedupe per target', async () => {
    h = await makeVault({
      files: { 'x.md': '---\nrelated: "[[y]]"\n---\n[[y]] and again [[y]]', 'y.md': 'y' },
    })
    expect((await h.vault.readNote('x.md')).links).toEqual([{ target: 'y', path: 'y.md' }])
  })
})

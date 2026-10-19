import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HttpError } from '../../src/errors.ts'
import { makeZip, PNG, textPdf } from './doc-fixtures.ts'
import { documentBytes, gitOut, makeVault, type Harness } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let h: Harness
beforeEach(async () => {
  h = await makeVault()
})
afterEach(async () => {
  await h.cleanup()
})

const failure = async (work: Promise<unknown>): Promise<HttpError> => {
  try {
    await work
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected a failure')
}
const commits = () => Number(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD').trim())
const SYMLINK = 0o120777

describe('preview', () => {
  test('lists what will be extracted and what is skipped, without storing anything', async () => {
    const zip = await makeZip({
      'notes/a.md': '# a',
      'b.txt': 'text',
      'tool.exe': 'MZ',
      '../evil.md': 'x',
    })
    const preview = await h.vault.docs.zipPreview(zip)
    const byPath = Object.fromEntries(preview.entries.map((e) => [e.path, e]))
    expect(byPath['notes/a.md']).toMatchObject({ action: 'extract', reason: null })
    expect(byPath['tool.exe']).toMatchObject({ action: 'skip', reason: 'type not supported' })
    expect(byPath['../evil.md']).toMatchObject({ action: 'skip' })
    expect(preview.extractCount).toBe(2)
    expect((await h.vault.tree()).notes.some((n) => n.path.startsWith('notes/'))).toBe(false)
  })
  test('something that is not a zip is refused', async () => {
    expect((await failure(h.vault.docs.zipPreview(Buffer.from('nope')))).status).toBe(415)
    const damaged = (await makeZip({ 'a.md': 'x' })).subarray(0, 30)
    expect((await failure(h.vault.docs.zipPreview(damaged))).status).toBe(415)
  })
})

describe('unzip', () => {
  test('mixed types land in one commit and go through the note and document pipeline', async () => {
    const zip = await makeZip({
      'readme.md': '# Inside\n\nfindable-note-word',
      'plain.txt': 'findable-txt-word',
      'sub/report.pdf': textPdf('findable-pdf-word'),
      'sub/data.csv': 'a,b\n1,2\n',
      'sub/pic.png': PNG,
      'sub/inner.zip': await makeZip({ 'deep.md': 'x' }),
      'sub/run.exe': 'MZ',
      'sub/fake.pdf': 'not really a pdf',
    })
    const before = commits()
    const result = await h.vault.docs.unzip(zip, 'pack.zip', 'imports/pack', 'ask')
    expect(result.folder).toBe('imports/pack')
    expect(result.written.sort()).toEqual(
      [
        'imports/pack/plain.md',
        'imports/pack/readme.md',
        'imports/pack/sub/data.csv',
        'imports/pack/sub/inner.zip',
        'imports/pack/sub/pic.png',
        'imports/pack/sub/report.pdf',
      ].sort(),
    )
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['sub/fake.pdf', 'sub/run.exe'])
    expect(commits()).toBe(before + 1)
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s')).toBe('Unzipped pack.zip\n')
    // text extraction and indexing for every kind
    expect(h.vault.search('findable-pdf-word', 5)[0]).toMatchObject({ kind: 'document' })
    expect(h.vault.search('findable-note-word', 5)[0]).toMatchObject({ kind: 'note' })
    expect(h.vault.search('findable-txt-word', 5)[0]?.path).toBe('imports/pack/plain.md')
    // nested zip kept as a file, not expanded
    const nested = await h.vault.docs.get('imports/pack/sub/inner.zip')
    expect(nested.entries?.map((e) => e.path)).toEqual(['deep.md'])
    expect(fs.existsSync(path.join(h.vaultDir, 'imports/pack/sub/deep.md'))).toBe(false)
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('score-unzip-'))).toEqual([])
  })

  test('zip slip: unsafe entries are skipped and nothing leaves the folder', async () => {
    const zip = await makeZip({
      'ok.md': 'ok',
      '../escape.md': 'x',
      '../../escape2.md': 'x',
      '/abs.md': 'x',
      'C:\\win.md': 'x',
      'a/../../up.md': 'x',
      '.git/config.md': 'x',
      '.hidden.md': 'x',
      'dir/.dotfile.md': 'x',
      '__MACOSX/._ok.md': 'x',
      'back\\slash.md': 'fine',
    })
    const result = await h.vault.docs.unzip(zip, 'z.zip', 'target', 'ask')
    expect(result.written.sort()).toEqual(['target/back/slash.md', 'target/ok.md'])
    expect(result.skipped.length).toBe(9)
    for (const outside of ['escape.md', 'escape2.md', 'abs.md', 'up.md', 'win.md'])
      expect(fs.existsSync(path.join(h.vaultDir, outside)), outside).toBe(false)
    expect(fs.existsSync(path.join(h.dir, 'escape.md'))).toBe(false)
    expect(fs.existsSync(path.join(h.vaultDir, '.git', 'config.md'))).toBe(false)
  })

  test('symbolic links and directory entries are ignored', async () => {
    const zip = await makeZip({
      'real.md': 'real',
      'link.md': { data: '/etc/passwd', unixPermissions: SYMLINK },
      'folder/': { data: '', dir: true },
    })
    const result = await h.vault.docs.unzip(zip, 'l.zip', 'out', 'ask')
    expect(result.written).toEqual(['out/real.md'])
    expect(result.skipped).toContainEqual({ path: 'link.md', reason: 'symbolic link' })
    expect(fs.existsSync(path.join(h.vaultDir, 'out/link.md'))).toBe(false)
  })

  test('a zip bomb is refused (ratio) and leaves nothing behind', async () => {
    const zip = await makeZip({ 'zeros.csv': Buffer.alloc(2 * 1024 * 1024, 0x61) })
    const err = await failure(h.vault.docs.unzip(zip, 'bomb.zip', 'bomb', 'ask'))
    expect(err).toMatchObject({ status: 413, code: 'zip_limits' })
    expect(fs.existsSync(path.join(h.vaultDir, 'bomb'))).toBe(false)
    expect((await failure(h.vault.docs.zipPreview(zip))).code).toBe('zip_limits')
  })

  test('more than 1,000 entries is refused before anything is read', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 1001; i += 1) files[`f${i}.md`] = `n${i}`
    const err = await failure(h.vault.docs.unzip(await makeZip(files), 'many.zip', 'many', 'ask'))
    expect(err).toMatchObject({ status: 413, code: 'zip_limits' })
    expect(fs.existsSync(path.join(h.vaultDir, 'many'))).toBe(false)
  })

  test('1,000 entries is fine', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 1000; i += 1) files[`f${i}.md`] = `n${i}`
    const result = await h.vault.docs.unzip(await makeZip(files), 'ok.zip', 'ok', 'ask')
    expect(result.written).toHaveLength(1000)
    // 1,000 files written and indexed is real work (4 s idle, 14 s on a fifth of a core): its own budget, not 30 s.
  }, 120_000)

  test('a header that lies about the size is caught while inflating', async () => {
    const zip = await makeZip({ 'a.md': 'x'.repeat(500) }, 'STORE')
    // Patch the uncompressed size in the central directory (offset 24 in the record) to claim 3 bytes.
    const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(3, at + 24)
    const result = await h.vault.docs.unzip(zip, 'lie.zip', 'lie', 'ask').then(
      () => 'ok' as const,
      (error: unknown) => error,
    )
    // Either the reader refuses the damaged zip or the size guard fires; it must never write 500 bytes as a 3-byte file.
    if (result !== 'ok') expect(result).toBeInstanceOf(HttpError)
    else
      expect(fs.readFileSync(path.join(h.vaultDir, 'lie/a.md'), 'utf8').length).toBeLessThanOrEqual(
        3,
      )
  })

  test('clashes: one question for the batch, then keep both or replace', async () => {
    await h.vault.writeNote('into/a.md', { body: 'old a', etag: null })
    await h.vault.docs.upload('into/b.pdf', textPdf('old b'), 'ask')
    const zip = await makeZip({ 'a.md': 'new a', 'b.pdf': textPdf('new b'), 'c.md': 'new c' })
    const asked = await failure(h.vault.docs.unzip(zip, 'z.zip', 'into', 'ask'))
    expect(asked.status).toBe(409)
    expect(
      (asked.details as { existing: { path: string }[] }).existing.map((e) => e.path).sort(),
    ).toEqual(['into/a.md', 'into/b.pdf'])
    expect(fs.existsSync(path.join(h.vaultDir, 'into/c.md'))).toBe(false)

    const kept = await h.vault.docs.unzip(zip, 'z.zip', 'into', 'keep')
    expect(kept.written.sort()).toEqual(['into/a (2).md', 'into/b (2).pdf', 'into/c.md'])
    expect((await h.vault.readNote('into/a.md')).body).toBe('old a')

    const replaced = await h.vault.docs.unzip(zip, 'z.zip', 'into', 'replace')
    expect(replaced.written).toContain('into/a.md')
    expect((await h.vault.readNote('into/a.md')).body).toBe('new a')
    expect((await h.vault.docs.get('into/b.pdf')).text).toContain('new b')
  })

  test('fix-l: keep both never overwrites an incoming file whose name is the suffixed one', async () => {
    await h.vault.writeNote('bundle/report.md', { body: 'old', etag: null })
    const zip = await makeZip({ 'report.md': 'first', 'report (2).md': 'second' })
    const result = await h.vault.docs.unzip(zip, 'z.zip', 'bundle', 'keep')
    expect(new Set(result.written).size).toBe(result.written.length)
    expect(result.written.sort()).toEqual(['bundle/report (2).md', 'bundle/report (3).md'])
    const bodies = [
      (await h.vault.readNote('bundle/report (2).md')).body,
      (await h.vault.readNote('bundle/report (3).md')).body,
    ].sort()
    expect(bodies).toEqual(['first', 'second'])
    expect((await h.vault.readNote('bundle/report.md')).body).toBe('old')
  })

  test('a zip name clash inside the zip (a.txt and a.md) keeps the first', async () => {
    const result = await h.vault.docs.unzip(
      await makeZip({ 'a.md': 'one', 'a.txt': 'two' }),
      'z.zip',
      'dup',
      'ask',
    )
    expect(result.written).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
  })
})

describe('keep as a zip', () => {
  test('stored as a document with its file list, not indexed', async () => {
    const zip = await makeZip({ 'one.md': 'zipped-secret-word', 'two.txt': 'x' })
    const stored = await h.vault.docs.upload('archive/bundle.zip', zip, 'ask')
    expect(stored).toMatchObject({ path: 'archive/bundle.zip', kind: 'document' })
    const doc = await h.vault.docs.get('archive/bundle.zip')
    expect(doc).toMatchObject({ type: 'zip', textStatus: 'none' })
    expect(doc.entries?.map((e) => e.path).sort()).toEqual(['one.md', 'two.txt'])
    expect(h.vault.search('zipped-secret-word', 5)).toEqual([])
    expect((await documentBytes(h.vault, 'archive/bundle.zip')).equals(zip)).toBe(true)
  })
})

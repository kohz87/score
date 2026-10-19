import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HttpError } from '../../src/errors.ts'
import { KnowledgeAgentApi } from '../../src/knowledge/agent-api.ts'
import { PNG, textDocx, textPdf } from './doc-fixtures.ts'
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

describe('upload and read', () => {
  test('a PDF is stored, its text indexed and found by search', async () => {
    const result = await h.vault.docs.upload(
      'reports/q3.pdf',
      textPdf('Zeppelin budget review'),
      'ask',
    )
    expect(result).toEqual({
      path: 'reports/q3.pdf',
      kind: 'document',
      replaced: false,
      history: 'committed',
    })
    const doc = await h.vault.docs.get('reports/q3.pdf')
    expect(doc).toMatchObject({
      type: 'pdf',
      textStatus: 'indexed',
      versioned: true,
      lastAuthor: 'you',
    })
    expect(doc.text).toContain('Zeppelin budget review')
    const hits = h.vault.search('zeppelin', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: 'reports/q3.pdf', kind: 'document', type: 'pdf' })
    expect(hits[0]!.snippet).toContain('[[')
    const tree = await h.vault.tree()
    expect(tree.documents.map((d) => d.path)).toEqual(['reports/q3.pdf'])
    expect(tree.folders).toContain('reports')
    expect(h.vault.info()).toMatchObject({ documents: 1 })
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%an %s')).toBe('You Add reports/q3.pdf\n')
    expect(h.events.at(-1)).toMatchObject({ path: 'reports/q3.pdf', kind: 'written', by: 'you' })
    expect(
      (await documentBytes(h.vault, 'reports/q3.pdf')).equals(textPdf('Zeppelin budget review')),
    ).toBe(true)
  })

  test('DOCX text is extracted', async () => {
    await h.vault.docs.upload('a.docx', await textDocx('Onboarding handbook'), 'ask')
    expect((await h.vault.docs.get('a.docx')).text).toContain('Onboarding handbook')
    expect(h.vault.search('handbook', 5)[0]).toMatchObject({ kind: 'document', type: 'docx' })
  })

  test('CSV and JSON are indexed as text; HTML loses scripts and tags', async () => {
    await h.vault.docs.upload('d/people.csv', Buffer.from('name,city\nAda,Lisbon\n'), 'ask')
    await h.vault.docs.upload('d/conf.json', Buffer.from('{"colour":"teal"}'), 'ask')
    await h.vault.docs.upload(
      'd/page.html',
      Buffer.from('<p>Visible words</p><script>hiddenscript()</script>'),
      'ask',
    )
    expect(h.vault.search('lisbon', 5)[0]?.path).toBe('d/people.csv')
    expect(h.vault.search('teal', 5)[0]?.path).toBe('d/conf.json')
    expect(h.vault.search('visible', 5)[0]?.path).toBe('d/page.html')
    expect(h.vault.search('hiddenscript', 5)).toEqual([])
  })

  test('images are stored but not indexed', async () => {
    await h.vault.docs.upload('pics/logo.png', PNG, 'ask')
    expect(await h.vault.docs.get('pics/logo.png')).toMatchObject({
      type: 'image',
      textStatus: 'none',
      text: '',
    })
  })

  test('a PDF the reader cannot parse is kept with "text not available"', async () => {
    await h.vault.docs.upload('broken.pdf', Buffer.from('%PDF-1.4 this is not a pdf'), 'ask')
    expect(await h.vault.docs.get('broken.pdf')).toMatchObject({
      textStatus: 'unavailable',
      text: '',
    })
  })

  test('text is redacted before it is indexed (D6)', async () => {
    await h.vault.docs.upload('k.csv', Buffer.from('note,value\nkey,sk-abcdefgh12345678\n'), 'ask')
    const doc = await h.vault.docs.get('k.csv')
    expect(doc.text).not.toContain('sk-abcdefgh12345678')
    expect(h.vault.search('abcdefgh12345678', 5)).toEqual([])
  })

  test('extracted text over 2 MiB is cut and marked', async () => {
    const big = `word ${'x'.repeat(100)}\n`.repeat(30_000) // ~3 MB
    await h.vault.docs.upload('big.csv', Buffer.from(big), 'ask')
    const doc = await h.vault.docs.get('big.csv')
    expect(doc.textStatus).toBe('truncated')
    expect(Buffer.byteLength(doc.text)).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
})

describe('notes from uploads', () => {
  test('.md is stored byte for byte, .txt becomes a .md note', async () => {
    const md = '---\ntitle:   Odd   spacing\n---\n# Heading\n\nbody\n'
    expect(await h.vault.docs.upload('inbox/a.md', Buffer.from(md), 'ask')).toMatchObject({
      path: 'inbox/a.md',
      kind: 'note',
    })
    expect(fs.readFileSync(path.join(h.vaultDir, 'inbox/a.md'), 'utf8')).toBe(md)
    const txt = await h.vault.docs.upload('inbox/plain.txt', Buffer.from('just words\n'), 'ask')
    expect(txt).toMatchObject({ path: 'inbox/plain.md', kind: 'note' })
    expect((await h.vault.readNote('inbox/plain.md')).body).toBe('just words\n')
    expect(h.vault.search('words', 5)[0]).toMatchObject({ path: 'inbox/plain.md', kind: 'note' })
  })

  test('binary content named .txt is refused', async () => {
    const err = await failure(h.vault.docs.upload('x.txt', Buffer.from([0, 1, 2, 3]), 'ask'))
    expect(err.status).toBe(415)
  })
})

describe('validation', () => {
  test('bytes must match the extension; unknown extensions are refused', async () => {
    expect((await failure(h.vault.docs.upload('a.pdf', Buffer.from('hello'), 'ask'))).status).toBe(
      415,
    )
    expect((await failure(h.vault.docs.upload('a.png', textPdf('x'), 'ask'))).status).toBe(415)
    expect((await failure(h.vault.docs.upload('a.docx', textPdf('x'), 'ask'))).status).toBe(415)
    expect((await failure(h.vault.docs.upload('a.exe', Buffer.from('MZ'), 'ask'))).status).toBe(415)
    expect((await failure(h.vault.docs.upload('a.svg', Buffer.from('<svg/>'), 'ask'))).status).toBe(
      415,
    )
    expect(
      (await failure(h.vault.docs.upload('a.csv', Buffer.from([0, 1, 2]), 'ask'))).status,
    ).toBe(415)
  })
  test('size limits: empty 400, over 256 MB 413', async () => {
    expect((await failure(h.vault.docs.upload('e.csv', Buffer.alloc(0), 'ask'))).status).toBe(400)
    const huge = Buffer.alloc(256 * 1024 * 1024 + 1)
    expect((await failure(h.vault.docs.upload('h.png', huge, 'ask'))).status).toBe(413)
  })
  test('path rules: no traversal, absolute, dotfiles or .git', async () => {
    for (const bad of [
      '../x.pdf',
      '/x.pdf',
      '.git/x.pdf',
      '.hidden.pdf',
      'a/.b/c.pdf',
      'a\0b.pdf',
    ]) {
      const err = await failure(h.vault.docs.upload(bad, textPdf('x'), 'ask'))
      expect(err.status, bad).toBe(400)
    }
    expect(fs.existsSync(path.join(h.dir, 'x.pdf'))).toBe(false)
  })
  test('a symlinked folder is not followed', async () => {
    const outside = path.join(h.dir, 'elsewhere')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(h.vaultDir, 'link'))
    const err = await failure(h.vault.docs.upload('link/x.pdf', textPdf('x'), 'ask'))
    expect(err.status).toBe(400)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe('name clashes', () => {
  test('ask answers 409 with the existing file; keep adds a suffix; replace overwrites', async () => {
    await h.vault.docs.upload('a.pdf', textPdf('first version'), 'ask')
    const clash = await failure(h.vault.docs.upload('a.pdf', textPdf('second version'), 'ask'))
    expect(clash.status).toBe(409)
    expect(clash.details).toMatchObject({ existing: [{ path: 'a.pdf' }] })
    const kept = await h.vault.docs.upload('a.pdf', textPdf('second version'), 'keep')
    expect(kept.path).toBe('a (2).pdf')
    const replaced = await h.vault.docs.upload('a.pdf', textPdf('third version'), 'replace')
    expect(replaced).toMatchObject({ path: 'a.pdf', replaced: true })
    expect((await h.vault.docs.get('a.pdf')).text).toContain('third version')
    expect(h.vault.search('first', 5)).toEqual([])
    expect(gitOut(h.vaultDir, 'log', '--format=%s', '--', 'a.pdf')).toContain('Replace a.pdf')
  })
  test('notes clash the same way, and a .txt clashes with its .md name', async () => {
    await h.vault.docs.upload('n.md', Buffer.from('# one'), 'ask')
    expect((await failure(h.vault.docs.upload('n.txt', Buffer.from('two'), 'ask'))).status).toBe(
      409,
    )
    expect((await h.vault.docs.upload('n.txt', Buffer.from('two'), 'keep')).path).toBe('n (2).md')
    await h.vault.docs.upload('n.md', Buffer.from('# three'), 'replace')
    expect((await h.vault.readNote('n.md')).body).toBe('# three')
  })
})

describe('git rules', () => {
  test('documents up to 10 MB are committed, larger ones are stored but not versioned', async () => {
    const small = Buffer.concat([PNG, Buffer.alloc(1024)])
    const large = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)])
    await h.vault.docs.upload('small.png', small, 'ask')
    await h.vault.docs.upload('large.png', large, 'ask')
    expect(gitOut(h.vaultDir, 'ls-files')).toContain('small.png')
    expect(gitOut(h.vaultDir, 'ls-files')).not.toContain('large.png')
    const tree = await h.vault.tree()
    expect(tree.documents.find((d) => d.path === 'large.png')).toMatchObject({ versioned: false })
    // A later note save must not sweep the stored-only file into "Outside changes".
    await h.vault.writeNote('later.md', { body: 'x', etag: null })
    expect(gitOut(h.vaultDir, 'ls-files')).not.toContain('large.png')
    expect(h.vault.info().documentBytes).toBeGreaterThan(11 * 1024 * 1024)
  })
})

describe('move and delete', () => {
  test('a moved document keeps its text searchable under the new path', async () => {
    await h.vault.docs.upload('a/old.pdf', textPdf('Mulberry strategy'), 'ask')
    expect(await h.vault.docs.move('a/old.pdf', 'b/new.pdf')).toEqual({
      path: 'b/new.pdf',
      updatedNotes: 0,
      skipped: [],
    })
    expect(h.vault.search('mulberry', 5)[0]?.path).toBe('b/new.pdf')
    expect(fs.existsSync(path.join(h.vaultDir, 'a/old.pdf'))).toBe(false)
    expect(h.events.at(-1)).toMatchObject({ path: 'a/old.pdf', kind: 'moved', to: 'b/new.pdf' })
    await failure(h.vault.docs.move('b/new.pdf', 'b/new.txt')) // type change refused
    await h.vault.docs.upload('b/other.pdf', textPdf('y'), 'ask')
    expect((await failure(h.vault.docs.move('b/new.pdf', 'b/other.pdf'))).status).toBe(409)
  })
  test('delete removes the file, the index and commits', async () => {
    await h.vault.docs.upload('gone.pdf', textPdf('Ephemeral content'), 'ask')
    await h.vault.docs.delete('gone.pdf')
    expect(h.vault.search('ephemeral', 5)).toEqual([])
    expect(fs.existsSync(path.join(h.vaultDir, 'gone.pdf'))).toBe(false)
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s')).toBe('Delete gone.pdf\n')
    expect((await failure(h.vault.docs.get('gone.pdf'))).status).toBe(404)
  })
  test('folders: create, refuse a duplicate, delete only when empty', async () => {
    await h.vault.createFolder('new/sub')
    expect((await h.vault.tree()).folders).toContain('new/sub')
    expect((await failure(h.vault.createFolder('new/sub'))).status).toBe(409)
    await h.vault.docs.upload('new/sub/a.png', PNG, 'ask')
    expect((await failure(h.vault.deleteFolder('new/sub'))).code).toBe('not_empty')
    await h.vault.docs.delete('new/sub/a.png')
    await h.vault.deleteFolder('new/sub')
    expect((await h.vault.tree()).folders).not.toContain('new/sub')
  })
})

describe('scanner', () => {
  test('a document added or removed outside Score is picked up', async () => {
    fs.mkdirSync(path.join(h.vaultDir, 'drop'))
    fs.writeFileSync(path.join(h.vaultDir, 'drop/found.pdf'), textPdf('Outside arrival'))
    await h.vault.scanNow()
    expect(h.vault.search('arrival', 5)[0]).toMatchObject({
      path: 'drop/found.pdf',
      kind: 'document',
    })
    expect(h.events.some((e) => e.path === 'drop/found.pdf' && e.by === 'outside')).toBe(true)
    fs.rmSync(path.join(h.vaultDir, 'drop/found.pdf'))
    await h.vault.scanNow()
    expect(h.vault.search('arrival', 5)).toEqual([])
  })
  test('a rebuild brings documents back from the files', async () => {
    await h.vault.docs.upload('r.pdf', textPdf('Rebuildable text'), 'ask')
    await h.vault.rebuild()
    expect(h.vault.search('rebuildable', 5)[0]?.path).toBe('r.pdf')
  })
  test('a file with the wrong bytes for its extension is not listed', async () => {
    fs.writeFileSync(path.join(h.vaultDir, 'fake.pdf'), 'not a pdf at all')
    await h.vault.scanNow()
    expect((await h.vault.tree()).documents).toEqual([])
  })
})

describe('agents', () => {
  test('search and read cover documents; write stays notes-only', async () => {
    const api = new KnowledgeAgentApi(h.vault, h.db)
    await h.vault.docs.upload('docs/spec.pdf', textPdf('Heliotrope protocol'), 'ask')
    await h.vault.docs.upload('docs/pic.png', PNG, 'ask')
    expect(api.search('lead', 'heliotrope', 5).items[0]).toMatchObject({
      kind: 'document',
      type: 'pdf',
    })
    const read = await api.read('lead', 'docs/spec.pdf')
    expect(read).toMatchObject({ kind: 'document', truncated: false, notice: null })
    expect(read.body).toContain('Heliotrope protocol')
    expect((await api.read('lead', 'docs/pic.png')).notice).toMatch(/image/)
    const listing = await api.list('lead', 'docs')
    expect(listing.documents.map((d) => d.path)).toEqual(['docs/pic.png', 'docs/spec.pdf'])
    expect((await failure(api.write('lead', 'docs/spec.pdf', 'x', null))).code).toBe('not_a_note')
    expect((await failure(api.append('lead', 'docs/new.csv', 'x'))).code).toBe('not_a_note')
  })
  test('the agent read is bounded and says so', async () => {
    const api = new KnowledgeAgentApi(h.vault, h.db)
    await h.vault.docs.upload(
      'b.csv',
      Buffer.from(`row,value\n${'cell,data\n'.repeat(60_000)}`),
      'ask',
    )
    const read = await api.read('lead', 'b.csv')
    expect(read.truncated).toBe(true)
    expect(Buffer.byteLength(read.body)).toBeLessThanOrEqual(256 * 1024)
    expect(read.notice).toMatch(/256 KiB/)
  })
})

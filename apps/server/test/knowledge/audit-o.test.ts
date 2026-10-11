import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { etagOf, hashContent, MAX_NOTE_BYTES } from '../../src/knowledge/note.ts'
import { buildNoteIndex, parseWikilinks, rewriteLinks } from '../../src/knowledge/links.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
  h = undefined as unknown as Harness
})

const read = (rel: string) => fs.readFileSync(path.join(h.vaultDir, rel), 'utf8')
const isTemp = (value: unknown) => /\.score-[^/]*\.tmp$/.test(String(value))

/**
 * Runs `before` once, right before Score publishes a temp file (whichever of rename/link it uses) or moves a
 * note: the deterministic barrier between "destination was absent" and "destination now exists".
 */
function atPublication(before: () => void, match: (from: unknown) => boolean) {
  let fired = false
  const fire = (from: unknown) => {
    if (!fired && match(from)) {
      fired = true
      before()
    }
  }
  const rename = fs.promises.rename
  const link = fs.promises.link
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    fire(from)
    return rename(from, to)
  })
  vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
    fire(from)
    return link(from, to)
  })
  return () => fired
}

describe('SCORE-002 no-replace publication', () => {
  test('a move does not overwrite a destination created after the lookup', async () => {
    h = await makeVault({ files: { 'a.md': 'source' } })
    const fired = atPublication(
      () => fs.writeFileSync(path.join(h.vaultDir, 'b.md'), 'concurrent'),
      (from) => String(from).endsWith('a.md'),
    )
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({ status: 409 })
    expect(fired()).toBe(true)
    expect(read('a.md')).toBe('source')
    expect(read('b.md')).toBe('concurrent')
  })

  test('a create (null etag) does not overwrite a file that appears just before publication', async () => {
    h = await makeVault()
    const fired = atPublication(
      () => fs.writeFileSync(path.join(h.vaultDir, 'n.md'), 'concurrent'),
      isTemp,
    )
    await expect(h.vault.writeNote('n.md', { body: 'mine', etag: null })).rejects.toMatchObject({
      status: 409,
    })
    expect(fired()).toBe(true)
    expect(read('n.md')).toBe('concurrent')
    expect(fs.readdirSync(h.vaultDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('a document move does not overwrite a destination created after the lookup', async () => {
    h = await makeVault()
    fs.writeFileSync(path.join(h.vaultDir, 'a.csv'), 'x,y\n1,2')
    await h.vault.scanNow()
    const fired = atPublication(
      () => fs.writeFileSync(path.join(h.vaultDir, 'b.csv'), 'concurrent'),
      (from) => String(from).endsWith('a.csv'),
    )
    await expect(h.vault.docs.move('a.csv', 'b.csv')).rejects.toMatchObject({ status: 409 })
    expect(fired()).toBe(true)
    expect(read('a.csv')).toBe('x,y\n1,2')
    expect(read('b.csv')).toBe('concurrent')
  })
})

describe('SCORE-003 link rewriting keeps outside edits', () => {
  test('an outside edit to a referring note between planning and applying survives the move', async () => {
    h = await makeVault({
      files: { 'a.md': 'target', 'b.md': 'see [[a]]', 'c.md': 'also [[a]]' },
    })
    const original = h.vault.git.commit.bind(h.vault.git)
    let edited = false
    vi.spyOn(h.vault.git, 'commit').mockImplementation(async (...args) => {
      if (!edited) {
        edited = true
        fs.writeFileSync(path.join(h.vaultDir, 'b.md'), 'see [[a]] plus my outside edit')
      }
      return original(...args)
    })
    const result = await h.vault.moveNote('a.md', 'z.md', true)
    expect(edited).toBe(true)
    expect(read('b.md')).toBe('see [[a]] plus my outside edit')
    expect(read('c.md')).toBe('also [[z]]')
    expect(result.updatedNotes).toBe(1)
    expect(fs.existsSync(path.join(h.vaultDir, 'z.md'))).toBe(true)
  })
})

describe('SCORE-034 a failed multi-file move resumes', () => {
  test('a failed second backlink write is finished on restart, keeping unrelated outside edits', async () => {
    const files = {
      'a.md': 'target',
      'b.md': 'one [[a]]',
      'c.md': 'two [[a]]',
      'd.md': 'three [[a]]',
    }
    h = await makeVault({ files })
    const real = h.vault.atomicWrite.bind(h.vault)
    let writes = 0
    vi.spyOn(h.vault, 'atomicWrite').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.md') && ++writes === 2) throw new Error('disk trouble')
      return real(...args)
    })
    await expect(h.vault.moveNote('a.md', 'z.md', true)).rejects.toMatchObject({
      code: 'move_incomplete',
    })
    vi.restoreAllMocks()
    expect(read('z.md')).toBe('target')
    const rewritten = ['b.md', 'c.md', 'd.md'].filter((name) => read(name).includes('[[z]]'))
    expect(rewritten).toHaveLength(1)
    // An unrelated outside edit to one of the pending notes while Score is down.
    const pending = ['b.md', 'c.md', 'd.md'].filter((name) => !rewritten.includes(name))
    fs.writeFileSync(path.join(h.vaultDir, pending[0]!), 'my own edit')
    // Restart: a new vault object on the same files and database.
    await h.vault.close()
    const { KnowledgeVault } = await import('../../src/knowledge/vault.ts')
    const second = new KnowledgeVault({
      watch: false,
      vault: h.vaultDir,
      db: h.db,
      emit: () => undefined,
      stateDir: path.join(h.dir, 'home', 'knowledge'),
    })
    await second.start()
    expect(read(pending[0]!)).toBe('my own edit')
    expect(read(pending[1]!)).toContain('[[z]]')
    expect(read(pending[1]!)).not.toContain('[[a]]')
    expect(fs.existsSync(second.planFile())).toBe(false)
    expect((await second.readNote('z.md')).backlinks.map((item) => item.path)).toContain(pending[1])
    await second.close()
  })
})

describe('SCORE-029 bounded reads', () => {
  test('a note swapped for an oversized file between the size check and the open is refused', async () => {
    h = await makeVault({ files: { 'a.md': 'small' } })
    const real = fs.promises.open
    let swapped = false
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith('a.md')) {
        swapped = true
        fs.writeFileSync(path.join(h.vaultDir, 'a.md'), 'x'.repeat(MAX_NOTE_BYTES + 10))
      }
      return real(...(args as Parameters<typeof real>))
    })
    await expect(h.vault.readContainedBuffer(path.join(h.vaultDir, 'a.md'))).rejects.toMatchObject({
      status: 413,
    })
    expect(swapped).toBe(true)
  })

  test('a file that keeps growing while it is read stops at the limit without reading it all', async () => {
    h = await makeVault({ files: { 'a.md': 'small' } })
    const real = fs.promises.open
    let served = 0
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof real>) => {
      const handle = await real(...args)
      return {
        fd: handle.fd,
        stat: async () => ({ size: 5, isFile: () => true }),
        read: async (buffer: Buffer) => {
          buffer.fill(97)
          served += buffer.length
          return { bytesRead: buffer.length, buffer }
        },
        readFile: async () => {
          throw new Error('unbounded readFile')
        },
        close: () => handle.close(),
      }
    }) as unknown as typeof fs.promises.open)
    await expect(h.vault.readContainedBuffer(path.join(h.vaultDir, 'a.md'))).rejects.toMatchObject({
      status: 413,
    })
    expect(served).toBeLessThan(MAX_NOTE_BYTES + 1024 * 1024)
  })
})

describe('SCORE-020 coherent note response', () => {
  test('a change between the first read and the index read never mixes versions', async () => {
    h = await makeVault({ files: { 'a.md': '# One\nbody one [[x]]' } })
    fs.writeFileSync(path.join(h.vaultDir, 'a.md'), '# One\nbody uno [[x]]') // stale index: same size, new content
    fs.utimesSync(path.join(h.vaultDir, 'a.md'), new Date(), new Date())
    const real = fs.promises.open
    let opens = 0
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('a.md') && ++opens === 2)
        fs.writeFileSync(path.join(h.vaultDir, 'a.md'), '# Two\nbody two [[y]]')
      return real(...(args as Parameters<typeof real>))
    })
    const note = await h.vault.readNote('a.md')
    vi.restoreAllMocks()
    const second = note.body.includes('body two')
    expect(note.title).toBe(second ? 'Two' : 'One')
    expect(note.links.map((link) => link.target)).toEqual(second ? ['y'] : ['x'])
    expect(note.etag).toBe(
      etagOf(hashContent(second ? '# Two\nbody two [[y]]' : '# One\nbody uno [[x]]')),
    )
  })
})

describe('SCORE-019 an incomplete walk deletes nothing', () => {
  test('a folder that cannot be listed keeps its notes, documents and links', async () => {
    h = await makeVault({
      files: { 'sub/a.md': 'in sub [[top]]', 'top.md': 'top [[a]]', 'sub/data.csv': 'x,y\n1,2' },
    })
    expect((await h.vault.tree()).notes.map((n) => n.path)).toContain('sub/a.md')
    expect((await h.vault.tree()).documents.map((d) => d.path)).toContain('sub/data.csv')
    const real = fs.promises.readdir
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]).endsWith(`${path.sep}sub`))
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return (real as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as unknown as typeof fs.promises.readdir)
    expect(await h.vault.scanNow()).toEqual([])
    vi.restoreAllMocks()
    const tree = await h.vault.tree()
    expect(tree.notes.map((n) => n.path)).toContain('sub/a.md')
    expect(tree.documents.map((d) => d.path)).toContain('sub/data.csv')
    expect((await h.vault.readNote('top.md')).links.map((l) => l.path)).toEqual(['sub/a.md'])
    expect(h.vault.search('sub', 5).map((x) => x.path)).toContain('sub/a.md')
  })
})

describe('SCORE-018 same-size, same-mtime edits', () => {
  test('a scan refreshes a note whose content changed but whose size and mtime did not', async () => {
    h = await makeVault({ files: { 'a.md': 'alpha [[b]]', 'b.md': 'target', 'c.md': 'gamma' } })
    const file = path.join(h.vaultDir, 'a.md')
    // A whole-second timestamp survives utimes exactly (fractional milliseconds can round by one), so the
    // index and the edited file really share size and mtime.
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    fs.utimesSync(file, stamp, stamp)
    await h.vault.scanNow()
    fs.writeFileSync(file, 'omega [[c]]')
    fs.utimesSync(file, stamp, stamp)
    expect(fs.statSync(file).mtimeMs).toBe(stamp.getTime())
    expect(await h.vault.scanNow()).toEqual(['a.md'])
    expect(h.vault.search('omega', 5).map((x) => x.path)).toEqual(['a.md'])
    expect((await h.vault.readNote('c.md')).backlinks.map((b) => b.path)).toEqual(['a.md'])
    expect((await h.vault.readNote('b.md')).backlinks).toEqual([])
  })
})

describe('SCORE-021 link rewriting follows Markdown literals', () => {
  const rewrite = (text: string) => {
    const before = buildNoteIndex(['a.md', 'n.md'])
    const after = buildNoteIndex(['z.md', 'n.md'])
    return rewriteLinks(text, 'n.md', 'a.md', 'z.md', before, after)
  }
  const literal: Array<[string, string]> = [
    ['indented code', 'intro\n\n    [[a]] in code\n\nend'],
    ['tab-indented code', 'intro\n\n\t[[a]] in code\n\nend'],
    ['indented code with blank lines inside', 'intro\n\n    one\n\n    [[a]]\n\nend'],
    ['longer outer backtick fence', '````md\n```\n[[a]]\n```\n[[a]]\n````\nend'],
    ['tilde fence holding backticks', '~~~~\n```\n[[a]]\n~~~\n[[a]]\n~~~~\nend'],
    ['fence indented by three spaces', '   ```\n[[a]]\n   ```\nend'],
    ['unclosed fence runs to the end', 'x\n```\n[[a]]\nstill code [[a]]'],
    ['inline code with a backtick inside', 'x ``code ` [[a]] more`` y'],
    ['inline triple backticks', 'x ```[[a]]``` y'],
    ['inline code across a line break', 'x `one\n[[a]] two` y'],
    ['escaped opening brackets', 'literal \\[[a]] here'],
    ['escaped brackets after an escaped backslash pair is live', ''],
  ]
  for (const [name, text] of literal) {
    if (text === '') continue
    test(`${name} stays byte for byte`, () => {
      const result = rewrite(text)
      expect(result.text).toBe(text)
      expect(result.count).toBe(0)
      expect(parseWikilinks(text)).toEqual([])
    })
  }

  const live: Array<[string, string, string]> = [
    ['after a closed fence', '```\ncode\n```\n[[a]]', '```\ncode\n```\n[[z]]'],
    ['after an indented block', 'p\n\n    code\n\n[[a]]', 'p\n\n    code\n\n[[z]]'],
    ['indented continuation of a paragraph', 'text\n    [[a]]', 'text\n    [[z]]'],
    ['indented continuation inside a list item', '- item\n\n    [[a]]', '- item\n\n    [[z]]'],
    ['unmatched backtick', 'x `[[a]] y', 'x `[[z]] y'],
    ['escaped backslash before the link', 'x \\\\[[a]]', 'x \\\\[[z]]'],
    ['single-backtick span does not close on a double run', 'x `a``b` [[a]]', 'x `a``b` [[z]]'],
    ['code span in another paragraph', 'x `open\n\n[[a]] `close`', 'x `open\n\n[[z]] `close`'],
  ]
  for (const [name, text, expected] of live)
    test(`${name} is still rewritten`, () => {
      const result = rewrite(text)
      expect(result.text).toBe(expected)
      expect(result.count).toBe(1)
    })
})

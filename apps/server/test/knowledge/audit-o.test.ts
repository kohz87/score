import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { etagOf, hashContent, MAX_NOTE_BYTES } from '../../src/knowledge/note.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
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
    })
    await second.start()
    expect(read(pending[0]!)).toBe('my own edit')
    expect(read(pending[1]!)).toContain('[[z]]')
    expect(read(pending[1]!)).not.toContain('[[a]]')
    expect(fs.existsSync(path.join(h.vaultDir, '.git', 'score-move-plan.json'))).toBe(false)
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

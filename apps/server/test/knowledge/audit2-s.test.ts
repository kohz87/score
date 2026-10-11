import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { moveNoReplace } from '../../src/knowledge/move-file.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { textPdf } from './doc-fixtures.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
  h = undefined
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const read = (rel: string) => fs.readFileSync(path.join(h!.vaultDir, rel), 'utf8')
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-s2-')))
  scratch.push(dir)
  return dir
}

/** Runs `after` right after the real hard link `from` -> `to` was made (the interval the audit names). */
function afterLink(from: string, to: string, after: () => void) {
  const real = fs.promises.link.bind(fs.promises)
  vi.spyOn(fs.promises, 'link').mockImplementation(async (a, b) => {
    await real(a, b)
    if (String(a).endsWith(from) && String(b).endsWith(to)) after()
  })
}
function externalReplace(file: string, content: string) {
  const temp = `${file}.editor-tmp`
  fs.writeFileSync(temp, content)
  fs.renameSync(temp, file)
}

describe('S2-001 a move never deletes a file that replaced its source', () => {
  test('a source replaced between the check and the link is moved whole, never left under two names', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'original')
    const realLink = fs.promises.link.bind(fs.promises)
    vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (a, b) => {
      externalReplace(path.join(dir, 'a.md'), 'saved just before the link')
      await realLink(a, b)
    })
    await moveNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md'))
    vi.restoreAllMocks()
    expect(fs.existsSync(path.join(dir, 'a.md'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('saved just before the link')
    expect(fs.statSync(path.join(dir, 'b.md')).nlink).toBe(1)
  })

  test('note: an external atomic save right after the link survives', async () => {
    h = await makeVault({ files: { 'a.md': 'original' } })
    afterLink('a.md', 'b.md', () => externalReplace(path.join(h!.vaultDir, 'a.md'), 'new edit'))
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({ status: 409 })
    vi.restoreAllMocks()
    expect(read('a.md')).toBe('new edit')
    // The older copy isn't presented as the moved file.
    expect(fs.existsSync(path.join(h.vaultDir, 'b.md'))).toBe(false)
    expect(fs.readdirSync(h.vaultDir).filter((name) => name.startsWith('.score-move'))).toEqual([])
  })

  test('document: the same', async () => {
    h = await makeVault()
    await h.vault.docs.upload('d.pdf', textPdf('original'), 'ask')
    afterLink('d.pdf', 'e.pdf', () =>
      externalReplace(path.join(h!.vaultDir, 'd.pdf'), 'new external edit'),
    )
    await expect(h.vault.docs.move('d.pdf', 'e.pdf')).rejects.toMatchObject({ status: 409 })
    vi.restoreAllMocks()
    expect(read('d.pdf')).toBe('new external edit')
    expect(fs.existsSync(path.join(h.vaultDir, 'e.pdf'))).toBe(false)
  })

  test('a file that is put back keeps a visible copy when the old name was taken again', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'original')
    const real = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (a, b) => {
      // Two outside saves: one lands before the old name is parked, one while it is parked.
      externalReplace(path.join(dir, 'a.md'), 'newer')
      await real(a, b)
      fs.writeFileSync(path.join(dir, 'a.md'), 'newest')
    })
    await expect(
      moveNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md')),
    ).rejects.toMatchObject({
      status: 409,
    })
    vi.restoreAllMocks()
    expect(fs.existsSync(path.join(dir, 'b.md'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('newest')
    const copies = fs.readdirSync(dir).filter((name) => name.includes('conflict copy'))
    expect(copies).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, copies[0]!), 'utf8')).toBe('newer')
  })
})

describe('S2-002 there is no replacing fallback', () => {
  test('unsupported hard links fail closed and the destination another writer created stays as it is', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'incoming')
    vi.spyOn(fs.promises, 'link').mockImplementation(async () => {
      fs.writeFileSync(path.join(dir, 'b.md'), 'external destination')
      throw Object.assign(new Error('nope'), { code: 'EOPNOTSUPP' })
    })
    await expect(
      moveNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md')),
    ).rejects.toMatchObject({ code: 'hard_links_unsupported' })
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('external destination')
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('incoming')
  })

  test('a source that can’t be read is an error, not a missing file', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'incoming')
    vi.spyOn(fs.promises, 'lstat').mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    )
    await expect(
      moveNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md')),
    ).rejects.toMatchObject({ code: 'EACCES' })
    vi.restoreAllMocks()
    await expect(
      moveNoReplace(path.join(dir, 'gone.md'), path.join(dir, 'c.md')),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('a note move on such a filesystem leaves everything in place', async () => {
    h = await makeVault({ files: { 'a.md': 'mine' } })
    vi.spyOn(fs.promises, 'link').mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'EPERM' }),
    )
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({
      code: 'hard_links_unsupported',
    })
    vi.restoreAllMocks()
    expect(read('a.md')).toBe('mine')
    expect(fs.existsSync(path.join(h.vaultDir, 'b.md'))).toBe(false)
    expect(fs.existsSync(h.vault.planFile())).toBe(false)
  })
})

describe('S2-013 the move plan lives in Score’s state', () => {
  test('a linked Git worktree starts, moves and recovers', async () => {
    const dir = tmp()
    const main = path.join(dir, 'main')
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd,
        encoding: 'utf8',
      })
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    fs.writeFileSync(path.join(main, 'a.md'), 'see [[b]]')
    fs.writeFileSync(path.join(main, 'b.md'), 'b')
    git(main, 'add', '.')
    git(main, 'commit', '-qm', 'init')
    const tree = path.join(dir, 'tree')
    git(main, 'worktree', 'add', '-q', tree, '-b', 'wt')
    expect(fs.lstatSync(path.join(tree, '.git')).isFile()).toBe(true)
    h = await makeVault()
    await h.vault.close()
    h.db.close()
    fs.rmSync(h.dir, { recursive: true, force: true })
    h = undefined
    const { migrate, openDatabase } = await import('../../src/db/index.ts')
    const db = openDatabase(path.join(dir, 'home', 'score.db'))
    migrate(db, new URL('../../migrations/', import.meta.url).pathname)
    const stateDir = path.join(dir, 'home', 'knowledge')
    const vault = new KnowledgeVault({
      vault: tree,
      db,
      emit: () => undefined,
      watch: false,
      stateDir,
    })
    await vault.start()
    try {
      await vault.moveNote('b.md', 'c.md', true)
      expect(fs.readFileSync(path.join(tree, 'a.md'), 'utf8')).toBe('see [[c]]')
      expect(fs.existsSync(vault.planFile())).toBe(false)
      expect(path.dirname(vault.planFile())).toBe(stateDir)
    } finally {
      await vault.close()
      db.close()
    }
  })

  test('a plan an older version kept under .git is moved once and then recovered', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    const plan = { from: 'gone.md', to: 'nowhere.md', author: 'you', items: [] }
    fs.writeFileSync(path.join(h.vaultDir, '.git', 'score-move-plan.json'), JSON.stringify(plan))
    const second = new KnowledgeVault({
      vault: h.vaultDir,
      db: h.db,
      emit: () => undefined,
      watch: false,
      stateDir: path.join(h.dir, 'home', 'knowledge'),
    })
    await second.start()
    await second.close()
    expect(fs.existsSync(path.join(h.vaultDir, '.git', 'score-move-plan.json'))).toBe(false)
  })
})

describe('S2-014 recovery converges when a finished rewrite was deleted', () => {
  test('both restarts succeed, the deletion stays and the plan ends', async () => {
    h = await makeVault({
      files: { 'a.md': 'target', 'b.md': 'one [[a]]', 'c.md': 'two [[a]]', 'd.md': 'three [[a]]' },
    })
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
    const done = ['b.md', 'c.md', 'd.md'].filter((name) => read(name).includes('[[z]]'))
    expect(done).toHaveLength(1)
    fs.rmSync(path.join(h.vaultDir, done[0]!))
    const warnings: string[] = []
    for (let round = 0; round < 2; round += 1) {
      const next = new KnowledgeVault({
        vault: h.vaultDir,
        db: h.db,
        emit: () => undefined,
        watch: false,
        stateDir: path.join(h.dir, 'home', 'knowledge'),
        log: { warn: (_object, message) => void warnings.push(message) },
      })
      await next.start()
      await next.close()
      expect(fs.existsSync(next.planFile())).toBe(false)
    }
    expect(fs.existsSync(path.join(h.vaultDir, done[0]!))).toBe(false)
    expect(warnings).not.toContain('Couldn’t finish an interrupted move; it was dropped')
  })
})

describe('S2-022 skipped link rewrites are reported', () => {
  test('the exact note that changed is listed with a reason; the others are counted', async () => {
    h = await makeVault({ files: { 'a.md': 'target', 'b.md': 'one [[a]]', 'c.md': 'two [[a]]' } })
    const real = h.vault.atomicWrite.bind(h.vault)
    let edited = false
    vi.spyOn(h.vault, 'atomicWrite').mockImplementation(async (...args) => {
      if (!edited && String(args[0]).endsWith('b.md')) {
        edited = true
        fs.writeFileSync(path.join(h!.vaultDir, 'b.md'), 'one [[a]] and my edit')
      }
      return real(...args)
    })
    const result = await h.vault.moveNote('a.md', 'z.md', true)
    expect(result.updatedNotes).toBe(1)
    expect(result.skipped.map((item) => item.path)).toEqual(['b.md'])
    expect(result.skipped[0]!.reason).toMatch(/changed/)
    expect(read('b.md')).toBe('one [[a]] and my edit')
  })
})

describe('S2-027 the plan is on disk before the vault changes', () => {
  test('the plan file and its folder are flushed before the first link, and clearing flushes too', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    const events: string[] = []
    const stateDir = path.join(h.dir, 'home', 'knowledge')
    const realOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        const handle = await realOpen(...args)
        const where = String(args[0])
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (where.startsWith(stateDir)) events.push(where === stateDir ? 'sync-dir' : 'sync-plan')
          return sync()
        }
        return handle
      },
    )
    const realLink = fs.promises.link.bind(fs.promises)
    vi.spyOn(fs.promises, 'link').mockImplementation(async (a, b) => {
      if (String(a).endsWith('a.md')) events.push('link-source')
      return realLink(a, b)
    })
    const realRm = fs.promises.rm.bind(fs.promises)
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
      if (String(file).includes('move-plan') && !String(file).endsWith('.tmp'))
        events.push('rm-plan')
      return realRm(file, options)
    })
    await h.vault.moveNote('a.md', 'b.md', false)
    vi.restoreAllMocks()
    const link = events.indexOf('link-source')
    expect(events.slice(0, link)).toEqual(['sync-plan', 'sync-dir'])
    expect(events.slice(link)).toEqual(['link-source', 'rm-plan', 'sync-dir'])
  })
})

describe('S2-019 note extensions', () => {
  test('.markdown and .MD uploads become .md notes that can be opened and moved', async () => {
    h = await makeVault()
    const a = await h.vault.docs.upload('chapter.markdown', Buffer.from('# one'), 'ask')
    const b = await h.vault.docs.upload('Other.MD', Buffer.from('# two'), 'ask')
    const c = await h.vault.docs.upload('Third.Markdown', Buffer.from('# three'), 'ask')
    expect([a.path, b.path, c.path]).toEqual(['chapter.md', 'Other.md', 'Third.md'])
    expect((await h.vault.readNote('chapter.md')).body).toContain('one')
    await h.vault.moveNote('Other.md', 'Renamed.md', false)
    expect(read('Renamed.md')).toBe('# two')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.cleanup())

const count = () => Number(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD'))
const authors = () =>
  gitOut(h.vaultDir, 'log', '--format=%an <%ae>|%cn <%ce>|%s').trim().split('\n')

describe('commits', () => {
  test('every save is a commit by the right author', async () => {
    h = await makeVault()
    await h.vault.writeNote('a.md', { body: '1', etag: null })
    await h.vault.writeNote('b.md', { body: '1', etag: null }, { agentId: 'builder' })
    expect(authors().slice(0, 2)).toEqual([
      'builder (agent) <builder@score.local>|builder (agent) <builder@score.local>|Create b.md',
      'You <you@score.local>|You <you@score.local>|Create a.md',
    ])
    expect(h.events.at(-1)).toEqual({
      path: 'b.md',
      kind: 'written',
      to: null,
      by: { agentId: 'builder' },
    })
    expect((await h.vault.tree()).notes.find((n) => n.path === 'b.md')?.lastAuthor).toEqual({
      agentId: 'builder',
    })
    expect((await h.vault.readNote('a.md')).lastAuthor).toBe('you')
  })

  test('agent ids cannot smuggle git syntax into the author', async () => {
    h = await makeVault()
    await h.vault.writeNote(
      'a.md',
      { body: '1', etag: null },
      { agentId: 'x <evil@e.com>\n--amend' },
    )
    expect(authors()[0]).toMatch(
      /^x--evil-e\.com----amend \(agent\) <x--evil-e\.com----amend@score\.local>/,
    )
  })

  test('rapid edits of one note by one author within 60 s amend; other cases do not', async () => {
    let now = 1_000_000
    h = await makeVault({ now: () => now })
    const base = count()
    const a1 = await h.vault.writeNote('a.md', { body: '1', etag: null })
    expect(count()).toBe(base + 1)
    now += 10_000
    const a2 = await h.vault.writeNote('a.md', { body: '2', etag: a1.etag })
    expect(count()).toBe(base + 1)
    expect(gitOut(h.vaultDir, 'show', 'HEAD:a.md')).toBe('2')
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s')).toBe('Create a.md\n')
    now += 10_000
    const b = await h.vault.writeNote('b.md', { body: '1', etag: null })
    expect(count()).toBe(base + 2)
    now += 10_000
    await h.vault.writeNote('a.md', { body: '3', etag: a2.etag }) // HEAD is b's commit
    expect(count()).toBe(base + 3)
    now += 1_000
    const a4 = await h.vault.writeNote(
      'a.md',
      { body: '4', etag: (await h.vault.readNote('a.md')).etag },
      { agentId: 'builder' },
    )
    expect(count()).toBe(base + 4) // another author
    now += 1_000
    await h.vault.writeNote('a.md', { body: '5', etag: a4.etag }, { agentId: 'builder' })
    expect(count()).toBe(base + 4)
    now += 61_000
    await h.vault.writeNote(
      'a.md',
      { body: '6', etag: (await h.vault.readNote('a.md')).etag },
      { agentId: 'builder' },
    )
    expect(count()).toBe(base + 5) // window over
    void b
  })

  test('an outside commit on top is never amended into', async () => {
    h = await makeVault()
    const a = await h.vault.writeNote('a.md', { body: '1', etag: null })
    gitOut(
      h.vaultDir,
      '-c',
      'user.name=Pat',
      '-c',
      'user.email=pat@example.com',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'by hand',
    )
    const before = count()
    await h.vault.writeNote('a.md', { body: '2', etag: a.etag })
    expect(count()).toBe(before + 1)
    expect(gitOut(h.vaultDir, 'log', '-2', '--format=%s').trim().split('\n')).toEqual([
      'Update a.md',
      'by hand',
    ])
  })

  test('a dirty tree is committed as "Outside changes" before Score\'s own commit', async () => {
    h = await makeVault({ files: { 'seed.md': 'seed' } })
    fs.writeFileSync(path.join(h.vaultDir, 'hand.md'), 'typed in an editor')
    fs.writeFileSync(path.join(h.vaultDir, 'seed.md'), 'edited in an editor')
    await h.vault.writeNote('mine.md', { body: 'x', etag: null })
    const log = gitOut(h.vaultDir, 'log', '-2', '--format=%an|%s').trim().split('\n')
    expect(log).toEqual(['You|Create mine.md', 'Outside changes|Outside changes'])
    expect(gitOut(h.vaultDir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('mine.md')
    expect(
      gitOut(h.vaultDir, 'show', '--name-only', '--format=', 'HEAD~1').trim().split('\n').sort(),
    ).toEqual(['hand.md', 'seed.md'])
    expect(gitOut(h.vaultDir, 'status', '--porcelain')).toBe('')
  })

  test('a vault inside another repository does not commit into it', async () => {
    h = await makeVault()
    await h.cleanup()
    // fresh harness whose vault folder sits in a repo of its own
    const { default: os } = await import('node:os')
    const { execFileSync } = await import('node:child_process')
    const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-kn-outer-')))
    try {
      execFileSync('git', ['-C', outer, 'init', '-q'])
      fs.mkdirSync(path.join(outer, 'vault'))
      fs.mkdirSync(path.join(outer, 'vault', 'sub'))
      // The vault has no .git of its own, so Score makes one: it is its own repository, not the outer one.
      const { KnowledgeVault } = await import('../../src/knowledge/vault.ts')
      const { migrate, openDatabase } = await import('../../src/db/index.ts')
      const db = openDatabase(path.join(outer, 'home', 'score.db'))
      migrate(db, new URL('../../migrations/', import.meta.url).pathname)
      const vault = new KnowledgeVault({
        vault: path.join(outer, 'vault'),
        db,
        emit: () => undefined,
        watch: false,
      })
      await vault.start()
      expect(vault.info().gitAvailable).toBe(true)
      expect(fs.existsSync(path.join(outer, 'vault', '.git'))).toBe(true)
      await vault.close()
      db.close()
    } finally {
      fs.rmSync(outer, { recursive: true, force: true })
    }
    h = await makeVault()
  })
})

describe('history, versions and restore', () => {
  test('history is newest first; versions return old bodies; restore is a new commit', async () => {
    let now = 1_000_000
    h = await makeVault({ now: () => now })
    const v1 = await h.vault.writeNote('n.md', {
      body: 'one',
      frontmatter: { title: 'T' },
      etag: null,
    })
    now += 120_000
    const v2 = await h.vault.writeNote('n.md', { body: 'two', etag: v1.etag })
    now += 120_000
    await h.vault.writeNote('n.md', { body: 'three', etag: v2.etag }, { agentId: 'builder' })
    const { items } = { items: await h.vault.history('n.md') }
    expect(items.map((i) => i.message)).toEqual(['Update n.md', 'Update n.md', 'Create n.md'])
    expect(items.map((i) => i.author)).toEqual([{ agentId: 'builder' }, 'you', 'you'])
    expect(items[0]?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(new Date(items[0]!.at).getTime()).not.toBeNaN()
    expect(await h.vault.version('n.md', items[2]!.commit)).toEqual({
      commit: items[2]!.commit,
      body: 'one',
    })
    expect((await h.vault.version('n.md', items[1]!.commit)).body).toBe('two')
    await expect(h.vault.version('n.md', '0123456')).rejects.toMatchObject({ status: 404 })
    const before = count()
    const restored = await h.vault.restoreNote('n.md', items[2]!.commit)
    expect(count()).toBe(before + 1)
    const note = await h.vault.readNote('n.md')
    expect(note.body).toBe('one')
    expect(note.frontmatter).toEqual({ title: 'T' }) // the whole file comes back
    expect(note.etag).toBe(restored.etag)
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s')).toBe(
      `Restore n.md to ${items[2]!.commit.slice(0, 7)}\n`,
    )
    expect(h.events.at(-1)).toEqual({ path: 'n.md', kind: 'restored', to: null, by: 'you' })
    // Old commits are all still reachable: nothing was rewritten.
    for (const item of items)
      expect(gitOut(h.vaultDir, 'cat-file', '-t', item.commit)).toBe('commit\n')
  })

  test('history follows a move; a commit of another note is not a version of this one', async () => {
    h = await makeVault()
    const a = await h.vault.writeNote('old.md', {
      body: 'content that stays long enough to be seen as a rename',
      etag: null,
    })
    await h.vault.writeNote('other.md', { body: 'other', etag: null })
    await h.vault.moveNote('old.md', 'new.md', false)
    const items = await h.vault.history('new.md')
    expect(items.map((i) => i.message)).toEqual(['Move old.md to new.md', 'Create old.md'])
    expect((await h.vault.version('new.md', items[1]!.commit)).body).toContain('content that stays')
    const other = (await h.vault.history('other.md'))[0]!
    await expect(h.vault.version('new.md', other.commit)).rejects.toMatchObject({ status: 404 })
    await expect(h.vault.restoreNote('new.md', other.commit)).rejects.toMatchObject({ status: 404 })
    void a
  })

  test('a deleted note can be restored from its history', async () => {
    h = await makeVault()
    await h.vault.writeNote('d.md', { body: 'precious', etag: null })
    await h.vault.deleteNote('d.md')
    const items = await h.vault.history('d.md')
    expect(items.map((i) => i.message)).toEqual(['Delete d.md', 'Create d.md'])
    await h.vault.restoreNote('d.md', items[1]!.commit)
    expect((await h.vault.readNote('d.md')).body).toBe('precious')
  })
})

describe('git missing', () => {
  test('notes still save; history is empty; gitAvailable is false', async () => {
    const empty = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'score-kn-nopath-'))
    const savedPath = process.env.PATH
    process.env.PATH = empty
    try {
      h = await makeVault()
    } finally {
      process.env.PATH = savedPath
      fs.rmSync(empty, { recursive: true, force: true })
    }
    expect(h.vault.info().gitAvailable).toBe(false)
    expect(fs.existsSync(path.join(h.vaultDir, '.git'))).toBe(false)
    const a = await h.vault.writeNote('a.md', { body: 'works', etag: null })
    await h.vault.writeNote('a.md', { body: 'still works', etag: a.etag })
    expect((await h.vault.readNote('a.md')).body).toBe('still works')
    expect(await h.vault.history('a.md')).toEqual([])
    await expect(h.vault.version('a.md', 'abcdef0')).rejects.toMatchObject({ status: 404 })
    await h.vault.moveNote('a.md', 'b.md', true)
    await h.vault.deleteNote('b.md')
  })
})

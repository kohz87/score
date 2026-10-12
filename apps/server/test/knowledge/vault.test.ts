import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.cleanup())

describe('first use', () => {
  test('creates the vault with git, a README and a first commit', async () => {
    h = await makeVault()
    expect(fs.existsSync(path.join(h.vaultDir, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(h.vaultDir, 'README.md'), 'utf8')).toContain('Knowledge')
    expect(gitOut(h.vaultDir, 'log', '--format=%s')).toBe('Create vault\n')
    expect(h.vault.info()).toEqual({
      vault: h.vaultDir,
      notes: 1,
      gitAvailable: true,
      agentAccess: true,
      documents: 0,
      documentBytes: 0,
      moveIssue: null,
    })
  })

  test('seeds neutral notes only when asked and the vault is empty', async () => {
    h = await makeVault({ seed: true })
    const tree = await h.vault.tree()
    expect(tree.notes.map((n) => n.path)).toContain('Projects/Roadmap.md')
    expect(tree.folders).toContain('Projects')
    const welcome = await h.vault.readNote('Welcome.md')
    expect(welcome.links).toContainEqual({
      target: 'Projects/Roadmap',
      path: 'Projects/Roadmap.md',
    })
    expect(welcome.links).toContainEqual({ target: 'Ideas backlog', path: null })
    expect((await h.vault.readNote('Glossary.md')).backlinks.map((b) => b.path)).toContain(
      'Welcome.md',
    )
  })

  test('an existing vault is left alone (no README, no seed)', async () => {
    h = await makeVault({ seed: true, files: { 'mine.md': '# Mine\n' } })
    expect(fs.existsSync(path.join(h.vaultDir, 'README.md'))).toBe(false)
    expect((await h.vault.tree()).notes.map((n) => n.path)).toEqual(['mine.md'])
  })
})

describe('write', () => {
  test('creates with etag null, refuses an existing note, stale etags give 412 with the current etag', async () => {
    h = await makeVault()
    const created = await h.vault.writeNote('Ideas/First.md', {
      body: '# First\n\nhello',
      etag: null,
    })
    expect(created.path).toBe('Ideas/First.md')
    await expect(
      h.vault.writeNote('Ideas/First.md', { body: 'x', etag: null }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'exists',
    })
    const next = await h.vault.writeNote('Ideas/First.md', {
      body: '# First\n\nhello 2',
      etag: created.etag,
    })
    expect(next.etag).not.toBe(created.etag)
    await expect(
      h.vault.writeNote('Ideas/First.md', { body: 'stale', etag: created.etag }),
    ).rejects.toMatchObject({
      status: 412,
      code: 'precondition_failed',
      details: { etag: next.etag },
    })
    await expect(h.vault.writeNote('Nope.md', { body: 'x', etag: 'abc' })).rejects.toMatchObject({
      status: 412,
      details: { etag: null },
    })
  })

  test('frontmatter: replaced when given, kept when omitted; title rules', async () => {
    h = await makeVault()
    const a = await h.vault.writeNote('a.md', {
      body: 'text',
      frontmatter: { title: 'Alpha', tags: ['x'] },
      etag: null,
    })
    let note = await h.vault.readNote('a.md')
    expect(note.title).toBe('Alpha')
    expect(note.frontmatter).toEqual({ title: 'Alpha', tags: ['x'] })
    expect(note.body).toBe('text')
    const b = await h.vault.writeNote('a.md', { body: 'new text', etag: a.etag })
    note = await h.vault.readNote('a.md')
    expect(note.frontmatter).toEqual({ title: 'Alpha', tags: ['x'] })
    await h.vault.writeNote('a.md', { body: '# Heading\n', frontmatter: {}, etag: b.etag })
    note = await h.vault.readNote('a.md')
    expect(note.frontmatter).toEqual({})
    expect(note.title).toBe('Heading')
    await h.vault.writeNote('plain.md', { body: 'no heading', etag: null })
    expect((await h.vault.readNote('plain.md')).title).toBe('plain')
    await h.vault.writeNote('code.md', { body: '```\n# not a title\n```\n', etag: null })
    expect((await h.vault.readNote('code.md')).title).toBe('code')
  })

  test('script frontmatter is never evaluated', async () => {
    h = await makeVault({ files: { 'x.md': '---js\n{ title: process.exit(3) }\n---\nbody\n' } })
    const note = await h.vault.readNote('x.md')
    expect(note.frontmatter).toEqual({})
    expect(note.body).toContain('body')
  })

  test('notes over 8 MiB are refused (413) and not indexed when found on disk', async () => {
    h = await makeVault()
    await expect(
      h.vault.writeNote('big.md', { body: 'a'.repeat(8 * 1024 * 1024 + 1), etag: null }),
    ).rejects.toMatchObject({ status: 413, code: 'payload_too_large' })
    fs.writeFileSync(path.join(h.vaultDir, 'huge.md'), 'b'.repeat(8 * 1024 * 1024 + 1))
    await h.vault.scanNow()
    expect((await h.vault.tree()).notes.map((n) => n.path)).not.toContain('huge.md')
    await expect(h.vault.readNote('huge.md')).rejects.toMatchObject({ status: 413 })
  })

  test('identical content writes nothing (no commit, no event)', async () => {
    h = await makeVault()
    const first = await h.vault.writeNote('same.md', { body: 'one', etag: null })
    const commits = gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD')
    const again = await h.vault.writeNote('same.md', { body: 'one', etag: first.etag })
    expect(again.etag).toBe(first.etag)
    expect(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD')).toBe(commits)
    expect(h.events.filter((e) => e.path === 'same.md')).toHaveLength(1)
  })
})

describe('path safety', () => {
  test.each([
    ['../x.md', 'bad_path'],
    ['a/../../x.md', 'bad_path'],
    ['/etc/x.md', 'bad_path'],
    ['a\0b.md', 'bad_path'],
    ['.git/config.md', 'bad_path'],
    ['sub/.GIT/x.md', 'bad_path'],
    ['.hidden/x.md', 'bad_path'],
    ['notes.txt', 'not_a_note'],
    ['attachments/pic.png', 'not_a_note'],
    ['folder/', 'not_a_note'],
    ['.md', 'not_a_note'],
  ])('%j is refused with %s', async (input, code) => {
    h = await makeVault()
    await expect(h.vault.writeNote(input, { body: 'x', etag: null })).rejects.toMatchObject({
      status: 400,
      code,
    })
    await expect(h.vault.readNote(input)).rejects.toMatchObject({ status: 400, code })
    await expect(h.vault.deleteNote(input)).rejects.toMatchObject({ status: 400, code })
  })

  test('a symlinked folder or note is never followed', async () => {
    h = await makeVault()
    const outside = path.join(h.dir, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.md'), 'top secret')
    fs.symlinkSync(outside, path.join(h.vaultDir, 'link'))
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(h.vaultDir, 'leak.md'))
    await expect(h.vault.writeNote('link/new.md', { body: 'x', etag: null })).rejects.toMatchObject(
      { code: 'bad_path' },
    )
    await expect(h.vault.readNote('link/secret.md')).rejects.toMatchObject({ code: 'bad_path' })
    await expect(h.vault.readNote('leak.md')).rejects.toMatchObject({ code: 'bad_path' })
    await expect(h.vault.writeNote('leak.md', { body: 'x', etag: 'a' })).rejects.toMatchObject({
      code: 'bad_path',
    })
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('top secret')
    expect(fs.readdirSync(outside)).toEqual(['secret.md'])
    await h.vault.scanNow()
    expect((await h.vault.tree()).notes.map((n) => n.path)).not.toContain('leak.md')
  })
})

describe('links and move', () => {
  test('wikilinks: exact path, unique basename, case-insensitive, alias, heading; ambiguous stays unresolved', async () => {
    h = await makeVault()
    for (const [p, b] of [
      ['People/Ada.md', '# Ada'],
      ['Teams/Core/Plan.md', '# Plan'],
      ['Teams/Other/Plan.md', '# Plan'],
    ] as const)
      await h.vault.writeNote(p, { body: b, etag: null })
    await h.vault.writeNote('Index.md', {
      body: '[[people/ada]] [[Ada|the founder]] [[Ada.md#Intro]] [[Plan]] [[Core/Plan]] [[Missing]] `[[InCode]]`\n```\n[[Fenced]]\n```\n[[#Top]]',
      etag: null,
    })
    const note = await h.vault.readNote('Index.md')
    const resolved = Object.fromEntries(note.links.map((l) => [l.target, l.path]))
    expect(resolved).toEqual({
      'people/ada': 'People/Ada.md',
      Ada: 'People/Ada.md',
      'Ada.md#Intro': 'People/Ada.md',
      Plan: null,
      'Core/Plan': 'Teams/Core/Plan.md',
      Missing: null,
      '#Top': 'Index.md',
    })
    expect((await h.vault.readNote('People/Ada.md')).backlinks).toEqual([
      { path: 'Index.md', title: 'Index' },
    ])
  })

  test('links re-resolve when notes appear and disappear', async () => {
    h = await makeVault()
    await h.vault.writeNote('a.md', { body: '[[b]]', etag: null })
    expect((await h.vault.readNote('a.md')).links[0]?.path).toBeNull()
    await h.vault.writeNote('b.md', { body: 'b', etag: null })
    expect((await h.vault.readNote('a.md')).links[0]?.path).toBe('b.md')
    await h.vault.deleteNote('b.md')
    expect((await h.vault.readNote('a.md')).links[0]?.path).toBeNull()
  })

  test('move with updateLinks rewrites links (rename first, then the edits); without it links break', async () => {
    h = await makeVault()
    await h.vault.writeNote('Old name.md', {
      body: '# Old\nself [[Old name]] and [[#x]]',
      etag: null,
    })
    await h.vault.writeNote('one.md', {
      body: 'see [[Old name]], [[Old name#Part|the part]] and [[old name|alias]]\n`[[Old name]]`',
      frontmatter: { title: 'One' },
      etag: null,
    })
    await h.vault.writeNote('two.md', { body: 'nothing', etag: null })
    h.events.length = 0
    const moved = await h.vault.moveNote('Old name.md', 'Folder/New name.md', true)
    expect(moved).toEqual({ path: 'Folder/New name.md', updatedNotes: 1, skipped: [] })
    const one = fs.readFileSync(path.join(h.vaultDir, 'one.md'), 'utf8')
    expect(one).toContain('---\ntitle: One\n---')
    expect(one).toContain(
      'see [[New name]], [[New name#Part|the part]] and [[New name|alias]]\n`[[Old name]]`',
    )
    expect(fs.readFileSync(path.join(h.vaultDir, 'Folder/New name.md'), 'utf8')).toContain(
      'self [[New name]] and [[#x]]',
    )
    expect(fs.existsSync(path.join(h.vaultDir, 'Old name.md'))).toBe(false)
    expect((await h.vault.readNote('Folder/New name.md')).backlinks.map((b) => b.path)).toEqual([
      'one.md',
    ])
    // The rename is a commit of its own (so git follows the file); the link edits come right after it.
    expect(gitOut(h.vaultDir, 'log', '-2', '--format=%s')).toBe(
      'Update links after moving Old name.md\nMove Old name.md to Folder/New name.md\n',
    )
    expect(
      gitOut(h.vaultDir, 'show', '--name-only', '--no-renames', '--format=', 'HEAD~1')
        .split('\n')
        .filter(Boolean)
        .sort(),
    ).toEqual(['Folder/New name.md', 'Old name.md'])
    expect(
      gitOut(h.vaultDir, 'show', '--name-only', '--format=', 'HEAD')
        .split('\n')
        .filter(Boolean)
        .sort(),
    ).toEqual(['Folder/New name.md', 'one.md'])
    expect(h.events).toContainEqual({
      path: 'Old name.md',
      kind: 'moved',
      to: 'Folder/New name.md',
      by: 'you',
    })
    expect(h.events).toContainEqual({ path: 'one.md', kind: 'written', to: null, by: 'you' })

    const plain = await h.vault.moveNote('Folder/New name.md', 'Elsewhere.md', false)
    expect(plain.updatedNotes).toBe(0)
    expect((await h.vault.readNote('one.md')).links.map((l) => l.path)).toEqual([null, null])
  })

  test('move refuses a taken target (409), a missing source (404) and bad paths', async () => {
    h = await makeVault()
    await h.vault.writeNote('a.md', { body: 'a', etag: null })
    await h.vault.writeNote('b.md', { body: 'b', etag: null })
    await expect(h.vault.moveNote('a.md', 'b.md', true)).rejects.toMatchObject({
      status: 409,
      code: 'exists',
    })
    await expect(h.vault.moveNote('zzz.md', 'c.md', true)).rejects.toMatchObject({ status: 404 })
    await expect(h.vault.moveNote('a.md', '../c.md', true)).rejects.toMatchObject({ status: 400 })
    await expect(h.vault.moveNote('a.md', 'c.txt', true)).rejects.toMatchObject({
      code: 'not_a_note',
    })
  })

  test('a link to a note gets a full path when the new name is ambiguous', async () => {
    h = await makeVault()
    await h.vault.writeNote('Other/Plan.md', { body: 'p', etag: null })
    await h.vault.writeNote('Draft.md', { body: 'd', etag: null })
    await h.vault.writeNote('ref.md', { body: '[[Draft]]', etag: null })
    await h.vault.moveNote('Draft.md', 'Mine/Plan.md', true)
    expect(fs.readFileSync(path.join(h.vaultDir, 'ref.md'), 'utf8')).toBe('[[Mine/Plan]]')
    expect((await h.vault.readNote('ref.md')).links[0]?.path).toBe('Mine/Plan.md')
  })
})

describe('delete', () => {
  test('removes the file, the index rows and commits', async () => {
    h = await makeVault()
    await h.vault.writeNote('gone.md', { body: 'findable-word', etag: null })
    expect(h.vault.search('findable', 5)).toHaveLength(1)
    await h.vault.deleteNote('gone.md')
    expect(fs.existsSync(path.join(h.vaultDir, 'gone.md'))).toBe(false)
    expect(h.vault.search('findable', 5)).toEqual([])
    expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s')).toBe('Delete gone.md\n')
    await expect(h.vault.deleteNote('gone.md')).rejects.toMatchObject({ status: 404 })
    expect(h.events.at(-1)).toEqual({ path: 'gone.md', kind: 'deleted', to: null, by: 'you' })
  })
})

describe('search', () => {
  test('ranks title above body, marks matches with [[ ]], prefix on the last word, FTS syntax is inert', async () => {
    h = await makeVault()
    await h.vault.writeNote('zebra.md', { body: 'a long text about animals', etag: null })
    await h.vault.writeNote('other.md', { body: 'we saw a zebra at the zoo yesterday', etag: null })
    const hits = h.vault.search('zebra', 10)
    expect(hits.map((x) => x.path)).toEqual(['zebra.md', 'other.md'])
    expect(hits[1]?.snippet).toContain('[[zebra]]')
    expect(h.vault.search('zeb', 10)).toHaveLength(2)
    for (const evil of [
      '"',
      'zebra OR',
      'NEAR(',
      'a AND',
      '*',
      'title:zebra',
      '-zebra',
      "'; DROP TABLE x; --",
      '(((',
      '\u0000',
      '   ',
    ])
      expect(() => h.vault.search(evil, 10)).not.toThrow()
    expect(h.vault.search('zebra AND NOT other', 10)).toEqual([])
    expect(h.vault.search('title:zebra', 10).length).toBeGreaterThanOrEqual(0)
    expect(h.vault.search('zebra', 1)).toHaveLength(1)
    expect(h.vault.search('', 10)).toEqual([])
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { moveNoReplace } from '../../src/knowledge/move-file.ts'
import { hashContent } from '../../src/knowledge/note.ts'
import { renameNoReplace, resetRenameSupport } from '../../src/knowledge/rename-noreplace.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { textPdf } from './doc-fixtures.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetRenameSupport()
  await h?.cleanup()
  h = undefined
  for (const dir of scratch.splice(0)) {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
const read = (rel: string) => fs.readFileSync(path.join(h!.vaultDir, rel), 'utf8')
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-s3-')))
  scratch.push(dir)
  return dir
}
function externalReplace(file: string, content: string) {
  const temp = `${file}.editor-tmp`
  fs.writeFileSync(temp, content)
  fs.renameSync(temp, file)
}
/** A second vault object on the same files and database: a restart. */
const restart = async (options: Partial<ConstructorParameters<typeof KnowledgeVault>[0]> = {}) => {
  await h!.vault.close()
  const events: unknown[] = []
  const vault = new KnowledgeVault({
    vault: h!.vaultDir,
    db: h!.db,
    emit: (change) => void events.push(change),
    watch: false,
    stateDir: path.join(h!.dir, 'home', 'knowledge'),
    ...options,
  })
  return { vault, events }
}
const leftovers = (dir: string) =>
  fs.readdirSync(dir).filter((name) => name.startsWith('.score-move'))

describe('S3-001 one atomic no-replace rename', () => {
  test('a destination that exists survives byte for byte and so does the source', async () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'source')
    fs.writeFileSync(path.join(dir, 'b.md'), 'concurrent edit')
    await expect(
      moveNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md')),
    ).rejects.toMatchObject({ status: 409 })
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('source')
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('concurrent edit')
    expect(fs.readdirSync(dir).sort()).toEqual(['a.md', 'b.md'])
  })

  // The audit's two interleavings of a concurrent destination writer, injected at the filesystem calls the old
  // link-and-unlink protocol made. The atomic rename makes neither call, so neither can happen; what must hold is the
  // outcome: the concurrent file is never deleted and the original never disappears.
  const everything = (dir: string) =>
    fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
  test.each([
    'right after the link, before the destination is read',
    'after the destination was read',
  ])('a destination replaced %s loses nothing', async (when) => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'original')
    const dest = path.join(dir, 'b.md')
    const realLink = fs.promises.link.bind(fs.promises)
    const realLstat = fs.promises.lstat.bind(fs.promises)
    let armed = false
    let injected = false
    vi.spyOn(fs.promises, 'link').mockImplementation(async (a, b) => {
      await realLink(a, b)
      if (String(b) !== dest) return
      if (when.startsWith('right')) {
        injected = true
        externalReplace(dest, 'concurrent edit')
      } else armed = true
    })
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: [fs.PathLike]) => {
      const stat = await realLstat(...args)
      if (armed && String(args[0]) === dest) {
        armed = false
        injected = true
        externalReplace(dest, 'concurrent edit')
      }
      return stat
    })
    await moveNoReplace(path.join(dir, 'a.md'), dest).catch(() => undefined)
    vi.restoreAllMocks()
    const files = everything(dir)
    expect(files).toContain('original')
    if (injected) expect(files).toContain('concurrent edit')
  })

  test('note: a destination created right before the rename survives and the move is a 409', async () => {
    h = await makeVault({ files: { 'a.md': 'original' } })
    const real = h.vault.moveNoReplace.bind(h.vault)
    vi.spyOn(h.vault, 'moveNoReplace').mockImplementation(async (a, b) => {
      fs.writeFileSync(path.join(h!.vaultDir, 'b.md'), 'concurrent edit')
      return real(a, b)
    })
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({ status: 409 })
    vi.restoreAllMocks()
    expect(read('a.md')).toBe('original')
    expect(read('b.md')).toBe('concurrent edit')
    expect(fs.existsSync(h.vault.planFile())).toBe(false)
  })

  test('note: a destination replaced right after the rename is the other writer’s; the original never vanishes', async () => {
    h = await makeVault({ files: { 'a.md': 'original' } })
    const before = fs.statSync(path.join(h.vaultDir, 'a.md')).ino
    const real = h.vault.moveNoReplace.bind(h.vault)
    let landed: number | undefined
    vi.spyOn(h.vault, 'moveNoReplace').mockImplementation(async (a, b) => {
      const result = await real(a, b)
      // The rename already moved the original; its identity at that moment is the moved file.
      landed = fs.statSync(String(b)).ino
      externalReplace(String(b), 'edit after the move')
      return result
    })
    await h.vault.moveNote('a.md', 'b.md', false)
    vi.restoreAllMocks()
    expect(landed).toBe(before)
    expect(fs.existsSync(path.join(h.vaultDir, 'a.md'))).toBe(false)
    expect(read('b.md')).toBe('edit after the move')
    expect(leftovers(h.vaultDir)).toEqual([])
  })

  test('a source saved again just before the rename moves the newer file', async () => {
    h = await makeVault({ files: { 'a.md': 'original' } })
    const real = h.vault.moveNoReplace.bind(h.vault)
    vi.spyOn(h.vault, 'moveNoReplace').mockImplementation(async (a, b) => {
      externalReplace(String(a), 'saved just before')
      return real(a, b)
    })
    await h.vault.moveNote('a.md', 'b.md', false)
    vi.restoreAllMocks()
    expect(fs.existsSync(path.join(h.vaultDir, 'a.md'))).toBe(false)
    expect(read('b.md')).toBe('saved just before')
    expect(fs.existsSync(h.vault.planFile())).toBe(false)
  })

  test('without a usable python3 the move is refused and nothing changes', async () => {
    h = await makeVault({ files: { 'a.md': 'mine' } })
    vi.stubEnv('SCORE_PYTHON', '/nonexistent/python')
    resetRenameSupport()
    await expect(h.vault.moveNote('a.md', 'b.md', false)).rejects.toMatchObject({
      code: 'rename_unsupported',
    })
    expect(read('a.md')).toBe('mine')
    expect(fs.existsSync(path.join(h.vaultDir, 'b.md'))).toBe(false)
    expect(fs.existsSync(h.vault.planFile())).toBe(false)
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.md'), 'x')
    await expect(
      renameNoReplace(path.join(dir, 'a.md'), path.join(dir, 'b.md'), null),
    ).rejects.toMatchObject({ code: 'rename_unsupported' })
    expect(fs.readdirSync(dir)).toEqual(['a.md'])
  })

  test('a missing source is 404; a folder that can’t be entered is an error, not a missing file', async () => {
    const dir = tmp()
    await expect(
      moveNoReplace(path.join(dir, 'gone.md'), path.join(dir, 'c.md')),
    ).rejects.toMatchObject({ status: 404 })
    fs.mkdirSync(path.join(dir, 'locked'))
    fs.writeFileSync(path.join(dir, 'locked', 'a.md'), 'x')
    fs.chmodSync(path.join(dir, 'locked'), 0o000)
    try {
      await expect(
        moveNoReplace(path.join(dir, 'locked', 'a.md'), path.join(dir, 'c.md')),
      ).rejects.toMatchObject({ code: 'move_failed' })
    } finally {
      fs.chmodSync(path.join(dir, 'locked'), 0o700)
    }
    expect(fs.existsSync(path.join(dir, 'c.md'))).toBe(false)
  })

  test('document: a destination created before the rename survives', async () => {
    h = await makeVault()
    await h.vault.docs.upload('d.pdf', textPdf('original'), 'ask')
    const real = h.vault.moveNoReplace.bind(h.vault)
    vi.spyOn(h.vault, 'moveNoReplace').mockImplementation(async (a, b) => {
      fs.writeFileSync(path.join(h!.vaultDir, 'e.pdf'), 'external')
      return real(a, b)
    })
    await expect(h.vault.docs.move('d.pdf', 'e.pdf')).rejects.toMatchObject({ status: 409 })
    vi.restoreAllMocks()
    expect(read('e.pdf')).toBe('external')
    expect(fs.existsSync(path.join(h.vaultDir, 'd.pdf'))).toBe(true)
  })
})

/** A plan as `moveNote` writes it (identity of the source included), for a move that is then interrupted. */
function writePlan(
  vaultDir: string,
  stateDir: string,
  vault: KnowledgeVault,
  plan: {
    from: string
    to: string
    source: string
    items?: Array<{ path: string; old: string; next: string }>
  },
) {
  const abs = path.join(vaultDir, plan.source)
  const st = fs.statSync(abs)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    vault.planFile(),
    JSON.stringify({
      from: plan.from,
      to: plan.to,
      author: 'you',
      state: 'active',
      identity: {
        dev: st.dev,
        ino: st.ino,
        birthtimeMs: st.birthtimeMs,
        size: st.size,
        hash: hashContent(fs.readFileSync(abs)),
      },
      items: (plan.items ?? []).map((item) => ({
        path: item.path,
        baseHash: hashContent(item.old),
        newHash: hashContent(item.next),
        content: item.next,
        done: false,
        skipped: false,
      })),
    }),
  )
}

describe('S3-002 recovery keeps its plan unless it is finished, abandoned or proven untouched', () => {
  const interrupted = async () => {
    h = await makeVault({ files: { 'a.md': 'target', 'b.md': 'one [[a]]', 'c.md': 'two [[a]]' } })
    const real = h.vault.atomicWrite.bind(h.vault)
    vi.spyOn(h.vault, 'atomicWrite').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.md')) throw new Error('disk trouble')
      return real(...args)
    })
    await expect(h.vault.moveNote('a.md', 'z.md', true)).rejects.toMatchObject({
      code: 'move_incomplete',
    })
    vi.restoreAllMocks()
    expect(fs.existsSync(h.vault.planFile())).toBe(true)
  }

  test('a transient failure during recovery keeps the plan, shows it, and a later retry converges', async () => {
    await interrupted()
    const { vault } = await restart({ moveRetryMs: 50 })
    const real = vault.atomicWrite.bind(vault)
    let failed = false
    let healed = false
    vi.spyOn(vault, 'atomicWrite').mockImplementation(async (...args) => {
      if (!healed && String(args[0]).endsWith('.md')) {
        failed = true
        throw Object.assign(new Error('input/output error'), { code: 'EIO' })
      }
      return real(...args)
    })
    await vault.start() // never fails because of it
    try {
      expect(failed).toBe(true)
      expect(fs.existsSync(vault.planFile())).toBe(true)
      expect(vault.info().moveIssue).toMatchObject({ state: 'pending', from: 'a.md', to: 'z.md' })
      await expect(vault.moveNote('z.md', 'y.md', false)).rejects.toMatchObject({
        status: 409,
        code: 'move_pending',
      })
      healed = true // the dependency recovers; nobody asks for a retry
      await vi.waitFor(() => expect(fs.existsSync(vault.planFile())).toBe(false), { timeout: 5000 })
      expect(vault.info().moveIssue).toBeNull()
      expect(read('b.md')).toBe('one [[z]]')
      expect(read('c.md')).toBe('two [[z]]')
    } finally {
      await vault.close()
    }
  })

  test('a directory flush that fails after the file moved does not discard the plan; the next start finishes it', async () => {
    h = await makeVault({ files: { 'a.md': 'target', 'b.md': 'one [[a]]' } })
    const realOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(
      async (...args: Parameters<typeof realOpen>) => {
        if (String(args[0]) === h!.vaultDir)
          throw Object.assign(new Error('input/output error'), { code: 'EIO' })
        return realOpen(...args)
      },
    )
    await expect(h.vault.moveNote('a.md', 'z.md', true)).rejects.toMatchObject({
      code: 'move_incomplete',
    })
    vi.restoreAllMocks()
    expect(read('z.md')).toBe('target')
    expect(fs.existsSync(h.vault.planFile())).toBe(true)
    const { vault } = await restart()
    await vault.start()
    try {
      expect(fs.existsSync(vault.planFile())).toBe(false)
      expect(read('b.md')).toBe('one [[z]]')
      expect(vault.info().moveIssue).toBeNull()
    } finally {
      await vault.close()
    }
  })

  test('an unreadable plan is set aside as .bad, startup continues and moves work', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    fs.mkdirSync(path.dirname(h.vault.planFile()), { recursive: true })
    fs.writeFileSync(h.vault.planFile(), '{not json')
    const { vault } = await restart()
    await vault.start()
    try {
      expect(fs.existsSync(vault.planFile())).toBe(false)
      expect(fs.readFileSync(`${vault.planFile()}.bad`, 'utf8')).toBe('{not json')
      await vault.moveNote('a.md', 'b.md', false)
      expect(read('b.md')).toBe('x')
    } finally {
      await vault.close()
    }
  })

  test('a helper that dies after the rename leaves a consistent, finished move', async () => {
    h = await makeVault({ files: { 'a.md': 'x', 'b.md': 'see [[a]]' } })
    const real = h.vault.moveNoReplace.bind(h.vault)
    vi.spyOn(h.vault, 'moveNoReplace').mockImplementation(async (a, b) => {
      await real(a, b)
      throw new Error('helper killed')
    })
    await expect(h.vault.moveNote('a.md', 'z.md', true)).rejects.toThrow('helper killed')
    vi.restoreAllMocks()
    // Settled by looking at the files: the move had happened, so it was finished, not forgotten.
    expect(read('z.md')).toBe('x')
    expect(read('b.md')).toBe('see [[z]]')
    expect(fs.existsSync(h.vault.planFile())).toBe(false)
  })
})

describe('S3-003 recovery needs proof the destination is the moved file', () => {
  const setup = async () => {
    h = await makeVault({ files: { 'a.md': 'the note', 'b.md': 'see [[a]]' } })
    await h.vault.close()
  }

  test('a source moved away and an unrelated destination created: no moved event, no rewrites, plan kept as conflicted', async () => {
    await setup()
    const { vault, events } = await restart()
    writePlan(h!.vaultDir, path.join(h!.dir, 'home', 'knowledge'), vault, {
      from: 'a.md',
      to: 'z.md',
      source: 'a.md',
      items: [{ path: 'b.md', old: 'see [[a]]', next: 'see [[z]]' }],
    })
    fs.renameSync(path.join(h!.vaultDir, 'a.md'), path.join(h!.vaultDir, 'elsewhere.md'))
    fs.writeFileSync(path.join(h!.vaultDir, 'z.md'), 'something unrelated')
    await vault.start()
    try {
      expect(events.filter((e) => (e as { kind: string }).kind === 'moved')).toEqual([])
      expect(read('b.md')).toBe('see [[a]]')
      expect(read('z.md')).toBe('something unrelated')
      expect(fs.existsSync(vault.planFile())).toBe(true)
      expect(vault.info().moveIssue).toMatchObject({
        state: 'conflicted',
        from: 'a.md',
        to: 'z.md',
      })
      // A restart does not retry it either, and further moves are held until the owner decides.
      await expect(vault.moveNote('b.md', 'y.md', false)).rejects.toMatchObject({
        code: 'move_pending',
      })
      await vault.dismissMoveIssue()
      expect(vault.info().moveIssue).toBeNull()
      expect(fs.existsSync(vault.planFile())).toBe(false)
      await vault.moveNote('b.md', 'y.md', false)
    } finally {
      await vault.close()
    }
  })

  test('the real moved file (same inode) is accepted: links are rewritten and the move is announced', async () => {
    await setup()
    const { vault, events } = await restart()
    writePlan(h!.vaultDir, path.join(h!.dir, 'home', 'knowledge'), vault, {
      from: 'a.md',
      to: 'z.md',
      source: 'a.md',
      items: [{ path: 'b.md', old: 'see [[a]]', next: 'see [[z]]' }],
    })
    fs.renameSync(path.join(h!.vaultDir, 'a.md'), path.join(h!.vaultDir, 'z.md'))
    await vault.start()
    try {
      expect(read('b.md')).toBe('see [[z]]')
      expect(events.filter((e) => (e as { kind: string }).kind === 'moved')).toHaveLength(1)
      expect(fs.existsSync(vault.planFile())).toBe(false)
      expect(vault.info().moveIssue).toBeNull()
    } finally {
      await vault.close()
    }
  })

  test('a plan whose move never happened ends, whatever sits at the destination', async () => {
    await setup()
    const { vault, events } = await restart()
    writePlan(h!.vaultDir, path.join(h!.dir, 'home', 'knowledge'), vault, {
      from: 'a.md',
      to: 'z.md',
      source: 'a.md',
    })
    fs.writeFileSync(path.join(h!.vaultDir, 'z.md'), 'someone else’s')
    await vault.start()
    try {
      expect(read('a.md')).toBe('the note')
      expect(read('z.md')).toBe('someone else’s')
      expect(fs.existsSync(vault.planFile())).toBe(false)
      expect(events.filter((e) => (e as { kind: string }).kind === 'moved')).toEqual([])
    } finally {
      await vault.close()
    }
  })
})

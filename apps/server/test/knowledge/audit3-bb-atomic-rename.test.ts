import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { moveNoReplace } from '../../src/knowledge/move-file.ts'
import { renameNoReplace, resetRenameSupport } from '../../src/knowledge/rename-noreplace.ts'
import { createAudit3Helpers, type Audit3State } from './audit3-bb-helpers.ts'
import { textPdf } from './doc-fixtures.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
const state: Audit3State = {
  get h() {
    return h
  },
  set h(value) {
    h = value
  },
  scratch: [],
}
const { externalReplace, install, leftovers, read, tmp } = createAudit3Helpers(state)
install()

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

describe('the rename helper process', () => {
  // Our own children only: the long-lived helper this test process started.
  const helperPids = () =>
    fs
      .readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .filter((pid) => {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
          const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          return (
            ppid === process.pid && cmd.includes('rename-noreplace.py') && cmd.includes('--serve')
          )
        } catch {
          return false
        }
      })
      .map(Number)

  test('a helper that dies is replaced and the next move works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-rename-respawn-'))
    try {
      fs.writeFileSync(path.join(dir, 'a'), 'one')
      await renameNoReplace(path.join(dir, 'a'), path.join(dir, 'b'))
      const [pid] = helperPids()
      expect(pid).toBeGreaterThan(0)
      process.kill(pid!, 'SIGKILL')
      await expect.poll(() => helperPids().includes(pid!)).toBe(false)
      fs.writeFileSync(path.join(dir, 'c'), 'two')
      await renameNoReplace(path.join(dir, 'c'), path.join(dir, 'd'))
      expect(fs.readFileSync(path.join(dir, 'd'), 'utf8')).toBe('two')
      expect(fs.existsSync(path.join(dir, 'c'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

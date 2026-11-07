import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { checkRoot, isInside } from '../../src/workspace/policy.ts'
import { code, home, open, policy, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

describe('audit fix batch N (workspace)', () => {
  // SCORE-004: a barrier between link and unlink; the source is atomically replaced while the move is paused.
  it('SCORE-004 a move never deletes a newer file that replaced the source mid-move', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'original')
    const ws = await open()
    const realLink = fsp.link.bind(fsp)
    let reached!: () => void
    const atBarrier = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const resume = new Promise<void>((resolve) => (release = resolve))
    const spy = vi.spyOn(fsp, 'link').mockImplementation(async (from, to) => {
      await realLink(from, to)
      reached()
      await resume
    })
    try {
      const moving = ws.move('a.txt', 'b.txt')
      await atBarrier
      fs.writeFileSync(path.join(root, 'new.tmp'), 'newer')
      fs.renameSync(path.join(root, 'new.tmp'), path.join(root, 'a.txt'))
      release()
      await moving
    } finally {
      spy.mockRestore()
    }
    expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('original')
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('newer')
    expect(fs.readdirSync(root).sort()).toEqual(['a.txt', 'b.txt'])
  })

  // SCORE-005
  it('SCORE-005 .git case variants are protected alike for direct and recursive delete', async () => {
    const ws = await open()
    for (const name of ['.git', '.Git', '.GIT']) {
      fs.mkdirSync(path.join(root, `p-${name}`, name), { recursive: true })
      fs.writeFileSync(path.join(root, `p-${name}`, name, 'HEAD'), 'ref')
      fs.writeFileSync(path.join(root, `p-${name}`, 'visible.txt'), 'x')
      expect(await code(ws.remove(`p-${name}`, true)), name).toBe('409:protected_inside')
      expect(fs.existsSync(path.join(root, `p-${name}`, name, 'HEAD')), name).toBe(true)
    }
    fs.mkdirSync(path.join(root, '.Git'))
    expect(await code(ws.remove('.Git', true))).toBe('403:blocked')
  })

  // SCORE-006
  it('SCORE-006 isInside treats ..name as a child, not a parent traversal', async () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/..backup')).toBe(true)
    expect(isInside('/a/b', '/a/c')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/a/..b')).toBe(false)
    const hidden = path.join(home, '.hermes', '..backup')
    fs.mkdirSync(hidden)
    expect((await checkRoot(hidden, policy)).ok).toBe(false)
  })

  // SCORE-028
  it('SCORE-028 a NUL after the first 8 KiB makes the file binary on read, as write would refuse it', async () => {
    const bytes = Buffer.alloc(10000, 0x61)
    bytes[9000] = 0
    fs.writeFileSync(path.join(root, 'late-nul.txt'), bytes)
    const ws = await open()
    expect(await ws.read('late-nul.txt')).toMatchObject({ kind: 'binary', reason: 'binary' })
    expect(await code(ws.write('x.txt', bytes.toString('utf8'), null))).toBe('400:bad_content')
  })
})

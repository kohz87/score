import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createAudit3Helpers, type Audit3State } from './audit3-bb-helpers.ts'
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
const { install, read, restart } = createAudit3Helpers(state)
install()

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

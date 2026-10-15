import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
import { makeVault, type Harness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
  h = undefined
})

const plan = { from: 'gone.md', to: 'nowhere.md', author: 'you', items: [] }

function open(harness: Harness, warnings: string[] = []): KnowledgeVault {
  return new KnowledgeVault({
    vault: harness.vaultDir,
    db: harness.db,
    emit: () => undefined,
    watch: false,
    stateDir: path.join(harness.dir, 'home', 'knowledge'),
    log: { warn: (_o, message) => void warnings.push(message) },
  })
}

describe('S4-002 the old move plan is deleted only after the copy is durable', () => {
  const failures: Record<string, (stateDir: string) => void> = {
    create: (stateDir) => {
      const real = fsp.open.bind(fsp)
      vi.spyOn(fsp, 'open').mockImplementation(((
        file: string,
        flags?: string,
        ...rest: never[]
      ) => {
        if (flags === 'wx' && String(file).startsWith(stateDir)) throw eio()
        return (real as (...a: unknown[]) => unknown)(file, flags, ...rest)
      }) as never)
    },
    write: (stateDir) => {
      const real = fsp.open.bind(fsp)
      vi.spyOn(fsp, 'open').mockImplementation((async (
        file: string,
        flags?: string,
        ...rest: never[]
      ) => {
        const handle = await (real as (...a: unknown[]) => Promise<fsp.FileHandle>)(
          file,
          flags,
          ...rest,
        )
        if (flags === 'wx' && String(file).startsWith(stateDir))
          vi.spyOn(handle, 'writeFile').mockRejectedValue(eio())
        return handle
      }) as never)
    },
    rename: (stateDir) => {
      const real = fsp.rename.bind(fsp)
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to).startsWith(stateDir)) throw eio()
        return real(from, to)
      })
    },
    'dir-sync': (stateDir) => {
      const real = fsp.open.bind(fsp)
      vi.spyOn(fsp, 'open').mockImplementation(((
        file: string,
        flags?: string,
        ...rest: never[]
      ) => {
        if (String(file) === stateDir && flags === 'r') throw eio()
        return (real as (...a: unknown[]) => unknown)(file, flags, ...rest)
      }) as never)
    },
  }
  const eio = () => Object.assign(new Error('EIO'), { code: 'EIO' })

  for (const [name, inject] of Object.entries(failures)) {
    test(`an I/O failure at ${name} keeps the old file; the next start migrates it`, async () => {
      h = await makeVault({ files: { 'a.md': 'x' } })
      const legacy = path.join(h.vaultDir, '.git', 'score-move-plan.json')
      fs.writeFileSync(legacy, JSON.stringify(plan))
      const stateDir = path.join(h.dir, 'home', 'knowledge')
      inject(stateDir)
      const warnings: string[] = []
      const failing = open(h, warnings)
      await failing.start()
      await failing.close()
      vi.restoreAllMocks()
      // A usable plan remains: the old file is still there (the new one, if any, is complete or absent).
      expect(fs.existsSync(legacy)).toBe(true)
      expect(warnings).toContain('Couldn’t move an old move plan')
      const later = open(h, warnings)
      await later.start()
      await later.close()
      expect(fs.existsSync(legacy)).toBe(false)
    })
  }

  test('a malformed old plan is the only thing that may be discarded', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    const legacy = path.join(h.vaultDir, '.git', 'score-move-plan.json')
    fs.writeFileSync(legacy, '{ not json')
    const warnings: string[] = []
    const next = open(h, warnings)
    await next.start()
    await next.close()
    expect(fs.existsSync(legacy)).toBe(false)
    expect(warnings).toContain('Discarded an unreadable move plan')
  })

  test('with both files present the newer plan is kept', async () => {
    h = await makeVault({ files: { 'a.md': 'x' } })
    const legacy = path.join(h.vaultDir, '.git', 'score-move-plan.json')
    const probe = open(h)
    const target = probe.planFile()
    await probe.close()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const old = { ...plan, from: 'old.md', to: 'older.md' }
    fs.writeFileSync(target, JSON.stringify(old))
    fs.writeFileSync(legacy, JSON.stringify(plan))
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(target, past, past)
    const spy = vi
      .spyOn(KnowledgeVault.prototype as unknown as { recoverMove(): Promise<void> }, 'recoverMove')
      .mockResolvedValue(undefined)
    const next = open(h)
    await next.start()
    const kept = JSON.parse(fs.readFileSync(target, 'utf8')) as { from: string }
    spy.mockRestore()
    await next.close()
    expect(kept.from).toBe('gone.md') // the legacy one was newer
    expect(fs.existsSync(legacy)).toBe(false)
  })
})

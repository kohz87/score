import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { hashContent } from '../../src/knowledge/note.ts'
import { KnowledgeVault } from '../../src/knowledge/vault.ts'
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

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { gitOut, makeVault, type Harness } from './helpers.ts'

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
    void gitOut
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

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_TEXT_BYTES, etagOf } from '../../src/workspace/workspace.ts'
import { code, events, open, outside, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

describe('writing', () => {
  it('creates, refuses an existing file on create, replaces with the right etag and returns 412 otherwise', async () => {
    const ws = await open()
    const created = await ws.write('notes.md', 'one', null)
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('one')
    expect(await code(ws.write('notes.md', 'again', null))).toBe('409:exists')
    const updated = await ws.write('notes.md', 'two', created.etag)
    expect(updated.etag).toBe(etagOf(Buffer.from('two')))
    await expect(ws.write('notes.md', 'three', created.etag)).rejects.toMatchObject({
      status: 412,
      details: { etag: updated.etag },
    })
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('two')
    fs.unlinkSync(path.join(root, 'notes.md'))
    await expect(ws.write('notes.md', 'x', updated.etag)).rejects.toMatchObject({
      status: 412,
      details: { etag: null },
    })
    expect(events.map((e) => e.op)).toEqual(['create', 'write'])
    expect(JSON.stringify(events)).not.toContain('two')
  })
  it('detects an outside edit between load and save', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'v1')
    const ws = await open()
    const { etag } = (await ws.read('a.txt')) as { etag: string }
    fs.writeFileSync(path.join(root, 'a.txt'), 'edited elsewhere')
    expect(await code(ws.write('a.txt', 'mine', etag))).toBe('412:precondition_failed')
  })
  it('writes atomically: no temp file is left behind and the mode of a replaced file is kept', async () => {
    fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    const ws = await open()
    const { etag } = (await ws.read('run.sh')) as { etag: string }
    await ws.write('run.sh', '#!/bin/sh\necho hi\n', etag)
    expect(fs.statSync(path.join(root, 'run.sh')).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(root)).toEqual(['run.sh'])
    // A failed write leaves the old content and no temp file.
    expect(await code(ws.write('run.sh', 'x', 'stale'))).toBe('412:precondition_failed')
    expect(fs.readFileSync(path.join(root, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(fs.readdirSync(root)).toEqual(['run.sh'])
  })
  it('enforces the 1 MiB text limit and rejects NUL content', async () => {
    const ws = await open()
    expect(await code(ws.write('big.txt', 'a'.repeat(MAX_TEXT_BYTES + 1), null))).toBe(
      '413:payload_too_large',
    )
    expect(await code(ws.write('ok.txt', 'a'.repeat(MAX_TEXT_BYTES), null))).toBe('ok')
    expect(await code(ws.write('nul.txt', 'a\0b', null))).toBe('400:bad_content')
    fs.writeFileSync(path.join(root, 'huge.txt'), Buffer.alloc(MAX_TEXT_BYTES + 5, 97))
    expect(await code(ws.write('huge.txt', 'x', 'anything'))).toBe('413:payload_too_large')
  })
  it('refuses blocked names for every kind of write', async () => {
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'plain.txt'), 'x')
    const ws = await open()
    for (const name of [
      '.env',
      'sub/.env.local',
      'k.pem',
      'a/b.key',
      'id_rsa',
      'auth.json',
      '.netrc',
    ]) {
      expect(await code(ws.write(name, 'x', null)), name).toBe('403:blocked')
      expect(await code(ws.upload(name, Buffer.from('x'))), name).toBe('403:blocked')
      expect(await code(ws.create(name, 'file')), name).toBe('403:blocked')
      expect(await code(ws.create(name, 'dir')), name).toBe('403:blocked')
      expect(await code(ws.move('plain.txt', name)), name).toBe('403:blocked')
    }
    expect(fs.readdirSync(root).sort()).toEqual(['plain.txt', 'sub'])
  })
  it('never writes through a symlinked file or a symlinked parent', async () => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'real')
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'))
    fs.symlinkSync(outside, path.join(root, 'outlink'))
    fs.mkdirSync(path.join(root, 'sub'))
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'sublink'))
    const ws = await open()
    expect(await code(ws.write('link.txt', 'x', 'any'))).toBe('403:symlink')
    expect(await code(ws.write('link.txt', 'x', null))).toBe('403:symlink')
    expect(await code(ws.write('outlink/new.txt', 'x', null))).toBe('403:symlink')
    expect(await code(ws.write('sublink/new.txt', 'x', null))).toBe('403:symlink')
    expect(await code(ws.upload('outlink/new.bin', Buffer.from('x')))).toBe('403:symlink')
    expect(await code(ws.create('outlink/d', 'dir'))).toBe('403:symlink')
    expect(await code(ws.remove('link.txt', false))).toBe('403:symlink')
    expect(await code(ws.remove('outlink', true))).toBe('403:symlink')
    expect(await code(ws.move('link.txt', 'moved.txt'))).toBe('403:symlink')
    expect(await code(ws.move('real.txt', 'outlink/moved.txt'))).toBe('403:symlink')
    expect(fs.readFileSync(path.join(root, 'real.txt'), 'utf8')).toBe('real')
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
    expect(fs.readdirSync(path.join(root, 'sub'))).toEqual([])
  })
  it('fails when the parent folder does not exist', async () => {
    const ws = await open()
    expect(await code(ws.write('missing/new.txt', 'x', null))).toBe('404:not_found')
  })
  it('serialises concurrent creates so exactly one wins', async () => {
    const ws = await open()
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => code(ws.write('race.txt', `v${i}`, null))),
    )
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === '409:exists')).toHaveLength(5)
    expect(fs.readdirSync(root)).toEqual(['race.txt'])
  })
  async function withSwap(
    trigger: string,
    swap: () => void,
    work: () => Promise<unknown>,
  ): Promise<string> {
    const realpath = fs.promises.realpath
    let swapped = 0
    ;(fs.promises as { realpath: unknown }).realpath = async (p: fs.PathLike) => {
      const out = await realpath(p)
      if (String(p) === trigger && swapped++ === 0) swap()
      return out
    }
    try {
      return await code(work())
    } finally {
      ;(fs.promises as { realpath: unknown }).realpath = realpath
      expect(swapped).toBeGreaterThan(0)
    }
  }
  it('catches the parent folder being swapped for a symlink after the check (last component)', async () => {
    fs.mkdirSync(path.join(root, 'dir'))
    const ws = await open()
    const result = await withSwap(
      path.join(root, 'dir'),
      () => {
        fs.rmdirSync(path.join(root, 'dir'))
        fs.symlinkSync(outside, path.join(root, 'dir'))
      },
      () => ws.write('dir/pwned.txt', 'x', null),
    )
    // O_DIRECTORY | O_NOFOLLOW on a symlink fails with ENOTDIR (mapped to 404) or ELOOP (403); never success.
    expect(['404:not_found', '403:symlink']).toContain(result)
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })
  it('catches an intermediate folder swapped for a symlink after the check (fd path comparison)', async () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    fs.mkdirSync(path.join(outside, 'b'))
    const ws = await open()
    const result = await withSwap(
      path.join(root, 'a', 'b'),
      () => {
        fs.renameSync(path.join(root, 'a'), path.join(root, 'a-old'))
        fs.symlinkSync(outside, path.join(root, 'a'))
      },
      () => ws.write('a/b/pwned.txt', 'x', null),
    )
    expect(result).toBe('409:changed')
    expect(fs.readdirSync(path.join(outside, 'b'))).toEqual([])
  })
  it('catches the same swap on rename, delete and upload', async () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
    fs.mkdirSync(path.join(outside, 'b'))
    fs.writeFileSync(path.join(outside, 'b', 'victim.txt'), 'keep')
    fs.writeFileSync(path.join(root, 'a', 'b', 'victim.txt'), 'mine')
    const ws = await open()
    const swap = () => {
      fs.renameSync(path.join(root, 'a'), path.join(root, 'a-old'))
      fs.symlinkSync(outside, path.join(root, 'a'))
    }
    expect(
      await withSwap(path.join(root, 'a', 'b'), swap, () => ws.remove('a/b/victim.txt', false)),
    ).toBe('409:changed')
    expect(fs.readFileSync(path.join(outside, 'b', 'victim.txt'), 'utf8')).toBe('keep')
    fs.rmSync(path.join(root, 'a'))
    fs.renameSync(path.join(root, 'a-old'), path.join(root, 'a'))
    expect(
      await withSwap(path.join(root, 'a', 'b'), swap, () => ws.move('a/b/victim.txt', 'top.txt')),
    ).toBe('409:changed')
    expect(fs.readFileSync(path.join(outside, 'b', 'victim.txt'), 'utf8')).toBe('keep')
    fs.rmSync(path.join(root, 'a'))
    fs.renameSync(path.join(root, 'a-old'), path.join(root, 'a'))
    expect(
      await withSwap(path.join(root, 'a', 'b'), swap, () =>
        ws.upload('a/b/up.bin', Buffer.from('x')),
      ),
    ).toBe('409:changed')
    expect(fs.readdirSync(path.join(outside, 'b'))).toEqual(['victim.txt'])
  })
  it('catches a read target swapped for a symlink out of the workspace after the check', async () => {
    fs.mkdirSync(path.join(root, 'a'))
    fs.writeFileSync(path.join(root, 'a', 'f.txt'), 'inside')
    fs.writeFileSync(path.join(outside, 'f.txt'), 'outside secret')
    const ws = await open()
    const result = await withSwap(
      path.join(root, 'a', 'f.txt'),
      () => {
        fs.unlinkSync(path.join(root, 'a', 'f.txt'))
        fs.symlinkSync(path.join(outside, 'f.txt'), path.join(root, 'a', 'f.txt'))
      },
      () => ws.read('a/f.txt'),
    )
    expect(result).toBe('409:changed')
  })
})

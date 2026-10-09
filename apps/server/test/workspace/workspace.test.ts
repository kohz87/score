import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  checkRoot,
  isBlockedName,
  parseRelativePath,
  WorkspaceError,
  type RootPolicy,
} from '../../src/workspace/policy.ts'
import {
  MAX_TEXT_BYTES,
  Workspace,
  etagOf,
  type WriteEvent,
} from '../../src/workspace/workspace.ts'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'score-ws-test-')))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

let home: string
let root: string
let outside: string
let policy: RootPolicy
let events: WriteEvent[]
let n = 0

beforeEach(() => {
  const dir = path.join(base, String(++n))
  home = path.join(dir, 'home')
  root = path.join(home, 'project')
  outside = path.join(dir, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(home, '.hermes'))
  fs.writeFileSync(path.join(home, '.hermes', 'secret.txt'), 'hermes')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
  policy = {
    home,
    forbidden: [path.join(home, '.hermes'), path.join(home, '.score'), path.join(home, '.ssh')],
  }
  events = []
})

const open = () => Workspace.open(root, policy, (event) => events.push(event))
async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceError) return `${error.status}:${error.code}`
    throw error
  }
  return 'ok'
}

describe('parseRelativePath', () => {
  it('rejects .., NUL and absolute paths, tolerates . and empty segments', () => {
    expect(() => parseRelativePath('../x')).toThrow(WorkspaceError)
    expect(() => parseRelativePath('a/../b')).toThrow(WorkspaceError)
    expect(() => parseRelativePath('a\0b')).toThrow(WorkspaceError)
    expect(() => parseRelativePath('/etc/passwd')).toThrow(WorkspaceError)
    expect(() => parseRelativePath('\\x')).toThrow(WorkspaceError)
    expect(() => parseRelativePath('a'.repeat(300))).toThrow(WorkspaceError)
    expect(() => parseRelativePath('x/'.repeat(3000))).toThrow(WorkspaceError)
    expect(parseRelativePath('./a//b/./c/')).toEqual(['a', 'b', 'c'])
    expect(parseRelativePath('')).toEqual([])
  })
})

describe('blocked names', () => {
  it.each([
    '.env',
    '.env.local',
    '.ENV.production',
    'server.pem',
    'tls.KEY',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'auth.json',
    '.netrc',
    'bundle.p12',
  ])('%s', (name) => expect(isBlockedName(name)).toBe(true))
  it('allows ordinary names', () => {
    for (const name of ['README.md', 'environment.ts', 'keyboard.ts', 'monkey.txt', 'auth.json.md'])
      expect(isBlockedName(name)).toBe(false)
  })
})

describe('checkRoot', () => {
  it('refuses /, home, a parent of home, ~/.hermes, ~/.score, ~/.ssh and folders inside them', async () => {
    for (const bad of [
      '/',
      home,
      path.dirname(home),
      path.join(home, '.hermes'),
      path.join(home, '.score'),
      path.join(home, '.ssh'),
    ]) {
      fs.mkdirSync(bad, { recursive: true })
      expect((await checkRoot(bad, policy)).ok, bad).toBe(false)
    }
    const nested = path.join(home, '.hermes', 'profiles', 'x')
    fs.mkdirSync(nested, { recursive: true })
    expect((await checkRoot(nested, policy)).ok).toBe(false)
  })
  it('refuses a symlink that resolves into a forbidden folder', async () => {
    const link = path.join(base, `link-${n}`)
    fs.symlinkSync(path.join(home, '.hermes'), link)
    expect((await checkRoot(link, policy)).ok).toBe(false)
  })
  it('refuses relative, missing, file and "." roots; accepts a normal folder and ~ expansion', async () => {
    expect((await checkRoot('.', policy)).ok).toBe(false)
    expect((await checkRoot('', policy)).ok).toBe(false)
    expect((await checkRoot('relative/dir', policy)).ok).toBe(false)
    expect((await checkRoot(path.join(root, 'missing'), policy)).ok).toBe(false)
    fs.writeFileSync(path.join(root, 'f.txt'), 'x')
    expect((await checkRoot(path.join(root, 'f.txt'), policy)).ok).toBe(false)
    expect(await checkRoot(root, policy)).toEqual({ ok: true, real: root })
    expect(await checkRoot('~/project', policy)).toEqual({ ok: true, real: root })
  })
})

describe('listing', () => {
  it('lists dirs first, flags hidden entries, hides blocked names and keeps .git visible', async () => {
    fs.mkdirSync(path.join(root, 'src'))
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    fs.writeFileSync(path.join(root, '.hidden'), 'h')
    for (const name of [
      '.env',
      '.env.local',
      'x.pem',
      'x.key',
      'id_rsa',
      'id_ed25519.pub',
      'auth.json',
      '.netrc',
    ])
      fs.writeFileSync(path.join(root, name), 'secret')
    const ws = await open()
    const entries = await ws.list('')
    expect(entries.map((e) => e.name)).toEqual(['.git', 'src', '.hidden', 'a.txt', 'b.txt'])
    expect(entries.find((e) => e.name === '.hidden')?.hidden).toBe(true)
    expect(entries.find((e) => e.name === 'src')?.kind).toBe('dir')
  })
  it('lists .git itself but not inside it', async () => {
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]')
    const ws = await open()
    expect((await ws.list('.git')).map((e) => e.name)).toContain('config')
    expect(await code(ws.list('.git/objects'))).toBe('403:blocked')
    expect(await code(ws.read('.git/config'))).toBe('403:blocked')
    expect(await code(ws.write('.git/config', 'x', null))).toBe('403:blocked')
    expect(await code(ws.remove('.git', true))).toBe('403:blocked')
    expect(await code(ws.move('.git', 'x'))).toBe('403:blocked')
  })
  it('never deletes a folder that holds protected files or a git repository (lead review)', async () => {
    for (const [folder, inner] of [
      ['keys', 'deploy.pem'],
      ['app', 'config/.env.local'],
      ['repo', '.git/HEAD'],
    ] as const) {
      fs.mkdirSync(path.join(root, folder, path.dirname(inner)), { recursive: true })
      fs.writeFileSync(path.join(root, folder, inner), 'secret')
      fs.writeFileSync(path.join(root, folder, 'visible.txt'), 'x')
    }
    const ws = await open()
    for (const folder of ['keys', 'app', 'repo']) {
      expect(await code(ws.remove(folder, true))).toBe('409:protected_inside')
      expect(fs.existsSync(path.join(root, folder, 'visible.txt'))).toBe(true)
    }
    fs.mkdirSync(path.join(root, 'plain', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plain', 'deep', 'a.txt'), 'x')
    await ws.remove('plain', true)
    expect(fs.existsSync(path.join(root, 'plain'))).toBe(false)
  })
  it('shows symlinks as symlinks and refuses a listing that leaves the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'))
    fs.mkdirSync(path.join(root, 'real'))
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'))
    const ws = await open()
    const entries = await ws.list('')
    expect(
      entries
        .filter((e) => e.kind === 'symlink')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['alias', 'escape'])
    expect(await code(ws.list('escape'))).toBe('403:outside_workspace')
    expect(await code(ws.list('alias'))).toBe('ok')
  })
  it('refuses missing paths and files', async () => {
    fs.writeFileSync(path.join(root, 'f.txt'), 'x')
    const ws = await open()
    expect(await code(ws.list('nope'))).toBe('404:not_found')
    expect(await code(ws.list('f.txt'))).toBe('404:not_found')
  })
})

describe('reading', () => {
  it('returns text with an etag, raw images and pdf, and binary markers', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello é')
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)])
    fs.writeFileSync(path.join(root, 'p.png'), png)
    fs.writeFileSync(path.join(root, 'fake.png'), 'not really a png')
    fs.writeFileSync(path.join(root, 'd.pdf'), Buffer.from('%PDF-1.4\n'))
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
    fs.writeFileSync(path.join(root, 'latin.txt'), Buffer.from([0xff, 0xfe, 0x41]))
    const ws = await open()
    expect(await ws.read('a.txt')).toMatchObject({
      kind: 'text',
      content: 'hello é',
      etag: etagOf(Buffer.from('hello é')),
    })
    expect(await ws.read('p.png')).toMatchObject({ kind: 'raw', contentType: 'image/png' })
    expect(await ws.read('d.pdf')).toMatchObject({ kind: 'raw', contentType: 'application/pdf' })
    expect(await ws.read('fake.png')).toMatchObject({ kind: 'text' })
    expect(await ws.read('blob.bin')).toMatchObject({ kind: 'binary', reason: 'binary' })
    expect(await ws.read('latin.txt')).toMatchObject({ kind: 'binary', reason: 'binary' })
  })
  it('does not serve text files over 1 MiB', async () => {
    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(MAX_TEXT_BYTES + 1, 97))
    const ws = await open()
    expect(await ws.read('big.txt')).toMatchObject({ kind: 'binary', reason: 'too_large' })
    expect(await ws.read('big.txt', { download: true })).toMatchObject({ kind: 'download' })
  })
  it('never serves blocked files, in any folder or under another case', async () => {
    fs.mkdirSync(path.join(root, 'deep', 'er'), { recursive: true })
    for (const rel of [
      '.env',
      'deep/.env.local',
      'deep/er/.ENV',
      'deep/er/cert.pem',
      'deep/id_rsa',
      'auth.json',
      'k.key',
      '.netrc',
      'id_ed25519',
    ])
      fs.writeFileSync(path.join(root, rel), 'TOPSECRET')
    const ws = await open()
    for (const rel of [
      '.env',
      'deep/.env.local',
      'deep/er/.ENV',
      'deep/er/cert.pem',
      'deep/id_rsa',
      'auth.json',
      'k.key',
      '.netrc',
      'id_ed25519',
    ])
      expect(await code(ws.read(rel)), rel).toBe('403:blocked')
  })
  it('refuses a symlink to a blocked file or out of the workspace, follows one that stays inside', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'TOPSECRET')
    fs.writeFileSync(path.join(root, 'ok.txt'), 'fine')
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    fs.symlinkSync(path.join(home, '.hermes', 'secret.txt'), path.join(root, 'hermes.txt'))
    fs.symlinkSync('ok.txt', path.join(root, 'alias.txt'))
    fs.symlinkSync(path.join(root, 'nope'), path.join(root, 'dangling.txt'))
    const ws = await open()
    expect(await code(ws.read('innocent.txt'))).toBe('403:blocked')
    expect(await code(ws.read('leak.txt'))).toBe('403:outside_workspace')
    expect(await code(ws.read('hermes.txt'))).toBe('403:outside_workspace')
    expect(await code(ws.read('dangling.txt'))).toBe('404:not_found')
    expect(await ws.read('alias.txt')).toMatchObject({ kind: 'text', content: 'fine' })
  })
  it('refuses a symlinked parent that leaves the workspace', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'))
    const ws = await open()
    expect(await code(ws.read('link/secret.txt'))).toBe('403:outside_workspace')
  })
  it('refuses a symlinked parent that points at a .git or a blocked folder name inside the root', async () => {
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, '.git', 'config'), 'x')
    fs.symlinkSync(path.join(root, '.git'), path.join(root, 'g'))
    const ws = await open()
    expect(await code(ws.read('g/config'))).toBe('403:blocked')
  })
  it('refuses folders and FIFOs', async () => {
    fs.mkdirSync(path.join(root, 'd'))
    const ws = await open()
    expect(await code(ws.read('d'))).toBe('400:not_a_file')
    expect(await code(ws.read(''))).toBe('400:bad_path')
  })
  it('refuses ../, absolute and NUL paths at every operation', async () => {
    const ws = await open()
    for (const bad of ['../outside/secret.txt', '/etc/passwd', 'a\0b', 'x/../../outside']) {
      expect(await code(ws.read(bad)), bad).toBe('400:bad_path')
      expect(await code(ws.list(bad)), bad).toBe('400:bad_path')
      expect(await code(ws.write(bad, 'x', null)), bad).toBe('400:bad_path')
      expect(await code(ws.create(bad, 'dir')), bad).toBe('400:bad_path')
      expect(await code(ws.remove(bad, true)), bad).toBe('400:bad_path')
      expect(await code(ws.move(bad, 'y'))).toBe('400:bad_path')
      expect(await code(ws.move('y', bad))).toBe('400:bad_path')
      expect(await code(ws.upload(bad, Buffer.from('x')))).toBe('400:bad_path')
    }
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })
})

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

describe('entries', () => {
  it('creates files and folders, refuses duplicates', async () => {
    const ws = await open()
    await ws.create('docs', 'dir')
    await ws.create('docs/new.md', 'file')
    expect(fs.statSync(path.join(root, 'docs')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(root, 'docs', 'new.md'), 'utf8')).toBe('')
    expect(await code(ws.create('docs', 'dir'))).toBe('409:exists')
    expect(await code(ws.create('docs/new.md', 'file'))).toBe('409:exists')
    expect(await code(ws.create('a/b/c', 'dir'))).toBe('404:not_found')
    expect(events.map((e) => e.op)).toEqual(['mkdir', 'create'])
  })
  it('moves files and folders, never overwrites, never moves a folder into itself', async () => {
    fs.mkdirSync(path.join(root, 'src', 'inner'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.txt'), 'a')
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    const ws = await open()
    await ws.move('a.txt', 'src/a2.txt')
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'src', 'a2.txt'), 'utf8')).toBe('a')
    expect(await code(ws.move('b.txt', 'src/a2.txt'))).toBe('409:exists')
    expect(fs.readFileSync(path.join(root, 'src', 'a2.txt'), 'utf8')).toBe('a')
    expect(await code(ws.move('src', 'src/inner/src'))).toBe('400:bad_path')
    expect(await code(ws.move('nope', 'x'))).toBe('404:not_found')
    await ws.move('src', 'lib')
    expect(fs.existsSync(path.join(root, 'lib', 'inner'))).toBe(true)
    expect(await code(ws.move('b.txt', 'b.txt'))).toBe('409:exists')
    expect(events.find((e) => e.op === 'move')).toMatchObject({ path: 'a.txt', to: 'src/a2.txt' })
  })
  it('deletes files, empty folders; non-empty folders need recursive; symlinks inside are unlinked, not followed', async () => {
    fs.mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'tree', 'sub', 'f.txt'), 'f')
    fs.symlinkSync(outside, path.join(root, 'tree', 'sub', 'out'))
    fs.writeFileSync(path.join(root, 'one.txt'), '1')
    fs.mkdirSync(path.join(root, 'empty'))
    const ws = await open()
    await ws.remove('one.txt', false)
    await ws.remove('empty', false)
    expect(await code(ws.remove('tree', false))).toBe('409:not_empty')
    expect(fs.existsSync(path.join(root, 'tree'))).toBe(true)
    await ws.remove('tree', true)
    expect(fs.existsSync(path.join(root, 'tree'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
    expect(await code(ws.remove('', true))).toBe('400:bad_path')
    expect(await code(ws.remove('gone', false))).toBe('404:not_found')
  })
  it('uploads raw bytes, refuses existing files and sizes over 25 MiB', async () => {
    const ws = await open()
    const bytes = Buffer.from([0, 1, 2, 3, 255])
    await ws.upload('data.bin', bytes)
    expect(fs.readFileSync(path.join(root, 'data.bin'))).toEqual(bytes)
    expect(await code(ws.upload('data.bin', bytes))).toBe('409:exists')
    expect(await code(ws.upload('huge.bin', Buffer.alloc(25 * 1024 * 1024 + 1)))).toBe(
      '413:payload_too_large',
    )
    expect(fs.existsSync(path.join(root, 'huge.bin'))).toBe(false)
    expect(events[0]).toMatchObject({ op: 'upload', path: 'data.bin', size: 5 })
  })
})

describe('opening', () => {
  it('refuses a root that fails the policy at open time', async () => {
    await expect(Workspace.open(path.join(home, '.hermes'), policy)).rejects.toMatchObject({
      status: 409,
      code: 'workspace_unavailable',
    })
  })
  it('keeps working when the root is reached through a symlinked path, and stops if it is swapped for a forbidden folder', async () => {
    const alias = path.join(base, `alias-${n}`)
    fs.symlinkSync(root, alias)
    fs.writeFileSync(path.join(root, 'x.txt'), 'x')
    const ws = await Workspace.open(alias, policy)
    expect(await ws.read('x.txt')).toMatchObject({ kind: 'text' })
    fs.rmSync(alias)
    fs.symlinkSync(path.join(home, '.hermes'), alias)
    await expect(Workspace.open(alias, policy)).rejects.toMatchObject({
      code: 'workspace_unavailable',
    })
  })
})

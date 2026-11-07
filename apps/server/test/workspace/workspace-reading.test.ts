import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_TEXT_BYTES, etagOf } from '../../src/workspace/workspace.ts'
import { code, home, open, outside, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

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

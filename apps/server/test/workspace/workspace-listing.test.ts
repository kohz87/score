import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, open, outside, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

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

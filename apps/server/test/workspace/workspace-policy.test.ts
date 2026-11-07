import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkRoot,
  isBlockedName,
  parseRelativePath,
  WorkspaceError,
} from '../../src/workspace/policy.ts'
import { base, home, n, policy, root, setupWorkspace } from './workspace-fixtures.ts'

setupWorkspace()

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

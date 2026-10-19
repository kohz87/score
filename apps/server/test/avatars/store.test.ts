import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AvatarStore } from '../../src/avatars/store.ts'
import { pngImage } from '../helpers/avatar-images.ts'

let home: string
let outside: string
let store: AvatarStore
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'score-avatars-'))
  home = join(dir, 'home')
  outside = join(dir, 'outside')
  mkdirSync(home)
  mkdirSync(outside)
  store = new AvatarStore(home)
})
afterEach(() => rmSync(join(home, '..'), { recursive: true, force: true }))
const bytes = pngImage(40, 40)

test('a picture is written under a random revision, private to the owner, and read back with its type', () => {
  const rev = store.write('lead', 'png', bytes)
  expect(rev).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  expect(store.write('lead', 'png', bytes)).not.toBe(rev)
  const file = join(home, 'avatars', 'lead', `${rev}.png`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(home, 'avatars', 'lead')).mode & 0o777).toBe(0o700)
  expect(statSync(join(home, 'avatars')).mode & 0o777).toBe(0o700)
  expect(store.read('lead', rev)).toEqual({ bytes, ext: 'png' })
  expect(store.read('lead', 'other-rev')).toBeNull()
  expect(store.read('builder', rev)).toBeNull()
})

test('no temp file is left behind, and the folder holds only finished pictures', () => {
  const rev = store.write('lead', 'webp', bytes)
  expect(readdirSync(join(home, 'avatars', 'lead'))).toEqual([`${rev}.webp`])
})

test('ids and revisions that are not plain names never touch the disk', () => {
  for (const id of ['../x', 'a/b', '', '.', '..', 'A', 'x'.repeat(65)])
    expect(() => store.write(id, 'png', bytes), id).toThrow()
  const rev = store.write('lead', 'png', bytes)
  expect(store.read('lead', `../lead/${rev}`)).toBeNull()
  expect(store.read('lead', '')).toBeNull()
  expect(store.read('../lead', rev)).toBeNull()
})

test('a symlink anywhere on the path is never followed: file, agent folder or the avatars folder', () => {
  writeFileSync(join(outside, 'secret.png'), bytes)
  const rev = 'plantedrevision001'
  // The file itself.
  mkdirSync(join(home, 'avatars', 'lead'), { recursive: true })
  symlinkSync(join(outside, 'secret.png'), join(home, 'avatars', 'lead', `${rev}.png`))
  expect(store.read('lead', rev)).toBeNull()
  // The agent's folder.
  symlinkSync(outside, join(home, 'avatars', 'builder'))
  writeFileSync(join(outside, `${rev}.png`), bytes)
  expect(store.read('builder', rev)).toBeNull()
  expect(() => store.write('builder', 'png', bytes)).toThrow()
  expect(readdirSync(outside).sort()).toEqual([`${rev}.png`, 'secret.png'])
  // The avatars folder.
  rmSync(join(home, 'avatars'), { recursive: true })
  mkdirSync(join(outside, 'lead'))
  writeFileSync(join(outside, 'lead', `${rev}.png`), bytes)
  symlinkSync(outside, join(home, 'avatars'))
  expect(store.read('lead', rev)).toBeNull()
  expect(() => store.write('lead', 'png', bytes)).toThrow()
  expect(readdirSync(join(outside, 'lead'))).toEqual([`${rev}.png`])
})

test('remove drops one revision; removeAgent drops the folder and never follows a link', () => {
  const first = store.write('lead', 'png', bytes)
  const second = store.write('lead', 'png', bytes)
  store.remove('lead', first)
  expect(store.read('lead', first)).toBeNull()
  expect(store.read('lead', second)).not.toBeNull()
  store.remove('lead', first) // already gone: not an error
  store.removeAgent('lead')
  expect(existsSync(join(home, 'avatars', 'lead'))).toBe(false)
  store.removeAgent('lead')
  // A planted link is removed as a link; what it points at stays.
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  symlinkSync(outside, join(home, 'avatars', 'builder'))
  store.removeAgent('builder')
  expect(existsSync(join(home, 'avatars', 'builder'))).toBe(false)
  expect(readdirSync(outside)).toEqual(['keep.txt'])
})

test('recovery keeps exactly the current picture of each agent and removes every stray', () => {
  const keep = store.write('lead', 'png', bytes)
  const old = store.write('lead', 'png', bytes) // a crash between the row commit and the removal
  writeFileSync(join(home, 'avatars', 'lead', `${keep}.png.tmp-1a2b`), bytes) // a crash mid-write
  const orphan = store.write('builder', 'jpg', bytes) // a crash before the row commit
  mkdirSync(join(home, 'avatars', 'gone'))
  writeFileSync(join(home, 'avatars', 'gone', 'x.png'), bytes)
  writeFileSync(join(home, 'avatars', 'stray-file'), 'x')
  symlinkSync(outside, join(home, 'avatars', 'planted'))
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  store.recover(new Map([['lead', keep]]))
  expect(readdirSync(join(home, 'avatars'))).toEqual(['lead'])
  expect(readdirSync(join(home, 'avatars', 'lead'))).toEqual([`${keep}.png`])
  expect(store.read('lead', old)).toBeNull()
  expect(store.read('builder', orphan)).toBeNull()
  expect(readdirSync(outside)).toEqual(['keep.txt'])
})

test('recovery on a first start, with no folder yet, does nothing', () => {
  store.recover(new Map())
  expect(existsSync(join(home, 'avatars'))).toBe(false)
})

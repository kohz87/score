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
import { PackStore } from '../../src/packs/store.ts'
import { gifImage, pngImage, webpImage } from '../helpers/pack-images.ts'

let home: string
let outside: string
let store: PackStore
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'score-packs-'))
  home = join(dir, 'home')
  outside = join(dir, 'outside')
  mkdirSync(home)
  mkdirSync(outside)
  store = new PackStore(home)
})
afterEach(() => rmSync(join(home, '..'), { recursive: true, force: true }))
const idle = webpImage(64, 64)
const work = gifImage(64, 64)
const files = [
  { activity: 'idle' as const, ext: 'webp' as const, bytes: idle },
  { activity: 'work' as const, ext: 'gif' as const, bytes: work },
]

test('a pack is written under a random revision, private to the owner, and each file read back with its type', () => {
  const rev = store.write('lead', files)
  expect(rev).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  expect(store.write('lead', files)).not.toBe(rev)
  const folder = join(home, 'packs', 'lead', rev)
  expect(readdirSync(folder).sort()).toEqual(['idle.webp', 'work.gif'])
  expect(statSync(join(folder, 'idle.webp')).mode & 0o777).toBe(0o600)
  for (const dir of [folder, join(home, 'packs', 'lead'), join(home, 'packs')])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(store.read('lead', rev, 'idle')).toEqual({ bytes: idle, ext: 'webp' })
  expect(store.read('lead', rev, 'work')).toEqual({ bytes: work, ext: 'gif' })
  expect(store.read('lead', rev, 'sleep')).toBeNull()
  expect(store.read('lead', 'other-rev', 'idle')).toBeNull()
  expect(store.read('builder', rev, 'idle')).toBeNull()
})

test('no temp folder is left behind: the agent folder holds only finished revisions', () => {
  const rev = store.write('lead', files)
  expect(readdirSync(join(home, 'packs', 'lead'))).toEqual([rev])
})

test('ids, revisions and activities that are not plain names never touch the disk', () => {
  for (const id of ['../x', 'a/b', '', '.', '..', 'A', 'x'.repeat(65)])
    expect(() => store.write(id, files), id).toThrow()
  const rev = store.write('lead', files)
  expect(store.read('lead', `../lead/${rev}`, 'idle')).toBeNull()
  expect(store.read('lead', rev, '../idle')).toBeNull()
  expect(store.read('lead', rev, 'idle.webp')).toBeNull()
  expect(store.read('lead', '', 'idle')).toBeNull()
  expect(store.read('../lead', rev, 'idle')).toBeNull()
  expect(() =>
    store.write('lead', [{ activity: 'dance' as never, ext: 'png', bytes: idle }]),
  ).toThrow()
})

test('a symlink anywhere on the path is never followed: file, revision, agent folder or the packs folder', () => {
  const secret = pngImage(64, 64)
  writeFileSync(join(outside, 'secret.png'), secret)
  const rev = 'plantedrevision001'
  // The file itself.
  mkdirSync(join(home, 'packs', 'lead', rev), { recursive: true })
  symlinkSync(join(outside, 'secret.png'), join(home, 'packs', 'lead', rev, 'idle.png'))
  expect(store.read('lead', rev, 'idle')).toBeNull()
  // The revision's folder.
  mkdirSync(join(outside, 'rev'))
  writeFileSync(join(outside, 'rev', 'idle.png'), secret)
  symlinkSync(join(outside, 'rev'), join(home, 'packs', 'lead', 'linkedrev0000001'))
  expect(store.read('lead', 'linkedrev0000001', 'idle')).toBeNull()
  // The agent's folder.
  mkdirSync(join(outside, 'agent', rev), { recursive: true })
  writeFileSync(join(outside, 'agent', rev, 'idle.png'), secret)
  symlinkSync(join(outside, 'agent'), join(home, 'packs', 'builder'))
  expect(store.read('builder', rev, 'idle')).toBeNull()
  expect(() => store.write('builder', files)).toThrow()
  expect(readdirSync(join(outside, 'agent'))).toEqual([rev])
  // The packs folder.
  rmSync(join(home, 'packs'), { recursive: true })
  mkdirSync(join(outside, 'lead', rev), { recursive: true })
  writeFileSync(join(outside, 'lead', rev, 'idle.png'), secret)
  symlinkSync(outside, join(home, 'packs'))
  expect(store.read('lead', rev, 'idle')).toBeNull()
  expect(() => store.write('lead', files)).toThrow()
  expect(readdirSync(join(outside, 'lead'))).toEqual([rev])
})

test('remove drops one revision; removeAgent drops the folder and never follows a link', () => {
  const first = store.write('lead', files)
  const second = store.write('lead', files)
  store.remove('lead', first)
  expect(store.read('lead', first, 'idle')).toBeNull()
  expect(existsSync(join(home, 'packs', 'lead', first))).toBe(false)
  expect(store.read('lead', second, 'idle')).not.toBeNull()
  store.remove('lead', first) // already gone: not an error
  store.removeAgent('lead')
  expect(existsSync(join(home, 'packs', 'lead'))).toBe(false)
  store.removeAgent('lead')
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  symlinkSync(outside, join(home, 'packs', 'builder'))
  store.removeAgent('builder')
  expect(existsSync(join(home, 'packs', 'builder'))).toBe(false)
  expect(readdirSync(outside)).toEqual(['keep.txt'])
})

test('a failed write leaves nothing behind', () => {
  store.write('lead', files)
  // An unwritable name for the second file makes the write fail half way.
  expect(() =>
    store.write('lead', [
      { activity: 'idle', ext: 'webp', bytes: idle },
      { activity: 'idle', ext: 'webp', bytes: idle },
    ]),
  ).toThrow()
  expect(readdirSync(join(home, 'packs', 'lead'))).toHaveLength(1)
})

test('recovery keeps exactly the current revision of each agent and removes every stray', () => {
  const keep = store.write('lead', files)
  const old = store.write('lead', files) // a crash between the row commit and the removal
  mkdirSync(join(home, 'packs', 'lead', '.tmp-1a2b'))
  writeFileSync(join(home, 'packs', 'lead', '.tmp-1a2b', 'idle.webp'), idle) // a crash mid-write
  writeFileSync(join(home, 'packs', 'lead', 'stray.txt'), 'x')
  const orphan = store.write('builder', files) // a crash before the row commit
  mkdirSync(join(home, 'packs', 'gone'))
  writeFileSync(join(home, 'packs', 'gone', 'x.png'), idle)
  writeFileSync(join(home, 'packs', 'stray-file'), 'x')
  symlinkSync(outside, join(home, 'packs', 'planted'))
  writeFileSync(join(outside, 'keep.txt'), 'keep')
  symlinkSync(outside, join(home, 'packs', 'lead', 'linked00000000001'))
  store.recover(new Map([['lead', keep]]))
  expect(readdirSync(join(home, 'packs'))).toEqual(['lead'])
  expect(readdirSync(join(home, 'packs', 'lead'))).toEqual([keep])
  expect(store.read('lead', keep, 'idle')).not.toBeNull()
  expect(store.read('lead', old, 'idle')).toBeNull()
  expect(store.read('builder', orphan, 'idle')).toBeNull()
  expect(readdirSync(outside)).toEqual(['keep.txt'])
})

test('recovery on a first start, with no folder yet, does nothing', () => {
  store.recover(new Map())
  expect(existsSync(join(home, 'packs'))).toBe(false)
})

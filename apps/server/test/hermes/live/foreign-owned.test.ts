import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { foreignOwned, foreignOwnedMessage } from '../../../src/hermes/live/profile-management.ts'

// 3.7.4: a profile folder with files another user owns (Hermes' Docker sandbox writes as root) can't be deleted by
// Hermes running as this user. A test can't make root-owned files, so "another user" is a different uid passed in.

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-foreign-'))
  mkdirSync(join(home, 'sandboxes', 'docker', 'default', 'home', '.hermes'), { recursive: true })
  writeFileSync(join(home, 'config.yaml'), 'x')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('a folder all of whose files are this user’s has nothing foreign', () => {
  expect(foreignOwned(home, process.getuid!())).toBeNull()
})

test('a file another user owns is found and named, relative to the profile', () => {
  const found = foreignOwned(home, process.getuid!() + 1)
  expect(found).not.toBeNull()
  expect(found!.startsWith(home)).toBe(true)
  const message = foreignOwnedMessage(home, join(home, 'sandboxes/docker/default/home/.hermes'))
  expect(message).toContain('sandboxes/docker/default/home/.hermes')
  expect(message).toMatch(/sudo chown -R [^ ]+: '/)
  expect(message).toContain(home)
})

test('symlinks are not followed and the walk is bounded', () => {
  const outside = mkdtempSync(join(tmpdir(), 'score-outside-'))
  try {
    symlinkSync(outside, join(home, 'link'))
    // Same user everywhere: the link's target is never walked into.
    expect(foreignOwned(home, process.getuid!())).toBeNull()
    // A limit of one entry stops before any deeper folder.
    expect(foreignOwned(home, process.getuid!(), 1)).toBeNull()
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

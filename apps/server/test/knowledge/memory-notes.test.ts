import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  buildMonthIndex,
  memoryFileLabel,
  saveMemoryNote,
  sortMemoryEntries,
} from '../../src/knowledge/memory-notes.ts'
import { parseNote } from '../../src/knowledge/note.ts'
import { gitOut, makeVault, type Harness } from './helpers.ts'

let h: Harness
beforeEach(async () => {
  h = await makeVault()
})
afterEach(() => h.cleanup())

// 17:00 UTC on 16 October is already 17 October in GMT+8.
const NOW = Date.UTC(2026, 9, 16, 17, 0, 0)
const input = (extra: Partial<Parameters<typeof saveMemoryNote>[1]> = {}) => ({
  agentId: 'builder',
  roomName: 'Launch plan',
  sessionId: 'score-room-1-builder',
  summary: '## Goal\nShip it.',
  now: NOW,
  ...extra,
})
const read = (rel: string) => fs.readFileSync(path.join(h.vaultDir, rel), 'utf8')

test('the note lands under Memory/<agent>/<YYYY>/<MM>/ with the date in GMT+8 and the agent as author', async () => {
  const rel = await saveMemoryNote(h.vault, input())
  expect(rel).toBe('Memory/builder/2026/10/2026-10-17 Launch plan.md')
  const note = parseNote(read(rel))
  expect(note.frontmatter).toEqual({
    date: '2026-10-17',
    agent: 'builder',
    room: 'Launch plan',
    session: 'score-room-1-builder',
    weight: 3,
    source: 'compaction',
  })
  expect(note.body.trim()).toBe('## Goal\nShip it.')
  expect(gitOut(h.vaultDir, 'log', '-1', '--format=%s', '--', rel).trim()).toContain(rel)
  const history = await h.vault.history(rel)
  expect(history[0]?.author).toEqual({ agentId: 'builder' })
})

test('a second compaction the same day gets (2), and an existing note is never overwritten', async () => {
  const first = await saveMemoryNote(h.vault, input({ summary: 'first' }))
  const second = await saveMemoryNote(h.vault, input({ summary: 'second' }))
  const third = await saveMemoryNote(h.vault, input({ summary: 'third' }))
  expect([second, third]).toEqual([
    'Memory/builder/2026/10/2026-10-17 Launch plan (2).md',
    'Memory/builder/2026/10/2026-10-17 Launch plan (3).md',
  ])
  expect(parseNote(read(first)).body.trim()).toBe('first')
  expect(parseNote(read(second)).body.trim()).toBe('second')
})

test('room names become safe file names', () => {
  expect(memoryFileLabel('a/b: c|d [x] #tag?')).toBe('a b c d x tag')
  expect(memoryFileLabel('///')).toBe('Room')
  expect(memoryFileLabel('x'.repeat(100))).toHaveLength(60)
})

test('the monthly index lists notes by weight (5 first), then newest day', async () => {
  const a = await saveMemoryNote(
    h.vault,
    input({ roomName: 'Alpha', now: Date.UTC(2026, 9, 3, 4) }),
  )
  const b = await saveMemoryNote(h.vault, input({ roomName: 'Beta', now: Date.UTC(2026, 9, 9, 4) }))
  const c = await saveMemoryNote(
    h.vault,
    input({ roomName: 'Gamma', now: Date.UTC(2026, 9, 5, 4) }),
  )
  const index = 'Memory/builder/2026/10/index.md'
  const order = () =>
    [...read(index).matchAll(/\[\[[^|]*\|([^\]]+)\]\]/g)].map((match) => match[1]!.slice(11))
  // All weight 3: newest first.
  expect(order()).toEqual(['Beta', 'Gamma', 'Alpha'])
  // The person raises Alpha to 5 and drops Beta to 1 by editing the frontmatter.
  for (const [rel, weight] of [
    [a, 5],
    [b, 1],
  ] as const) {
    const note = await h.vault.readNote(rel)
    await h.vault.writeNote(rel, {
      body: note.body,
      frontmatter: { ...note.frontmatter, weight },
      etag: note.etag,
    })
  }
  await h.vault.scanNow()
  expect(order()).toEqual(['Alpha', 'Gamma', 'Beta'])
  expect(c).toContain('Gamma')
  // The index is a note of the vault, written by Score, and a scan without changes leaves it alone.
  const before = gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD')
  await h.vault.scanNow()
  expect(gitOut(h.vaultDir, 'rev-list', '--count', 'HEAD')).toBe(before)
  expect((await h.vault.readNote(index)).body).toContain('# Memory of builder, 2026-10')
})

test('months and agents keep separate indexes; deleting a note drops it from its index', async () => {
  const a = await saveMemoryNote(h.vault, input({ roomName: 'One' }))
  await saveMemoryNote(h.vault, input({ roomName: 'Two', now: Date.UTC(2026, 10, 20, 4) }))
  await saveMemoryNote(h.vault, input({ roomName: 'Three', agentId: 'lead' }))
  expect(read('Memory/builder/2026/10/index.md')).toContain('One')
  expect(read('Memory/builder/2026/10/index.md')).not.toContain('Two')
  expect(read('Memory/builder/2026/11/index.md')).toContain('Two')
  expect(read('Memory/lead/2026/10/index.md')).toContain('Three')
  fs.rmSync(path.join(h.vaultDir, a))
  await h.vault.scanNow()
  expect(read('Memory/builder/2026/10/index.md')).toContain('No notes yet.')
})

test('weights outside 1–5 count as 3 in the index order', () => {
  const entry = (name: string, weight: unknown) => ({
    path: `Memory/a/2026/10/2026-10-0${name} x.md`,
    title: name,
    frontmatter: { weight },
  })
  expect(
    sortMemoryEntries([entry('1', 9), entry('2', 'high'), entry('3', 4), entry('4', 2)]).map(
      (item) => item.title,
    ),
  ).toEqual(['3', '2', '1', '4'])
  expect(buildMonthIndex('Memory/a/2026/10', [])).toContain('No notes yet.')
})

import { expect, test } from 'vitest'
import { unifiedDiff } from '../../src/domain/line-diff.ts'
import {
  replayWorkbench,
  type CommentEvent,
  type EditEvent,
} from '../../src/domain/exchanges/workbench-replay.ts'

let order = 0
const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute)).toISOString()
const edit = (
  minute: number,
  agentId: string,
  before: string,
  after: string,
  path = 'src/feed.ts',
): EditEvent => ({
  kind: 'edit',
  at: at(minute),
  order: order++,
  agentId,
  path,
  diff: unifiedDiff(before, after),
  language: 'typescript',
})
const note = (minute: number, line: number, text: string, path = 'src/feed.ts'): CommentEvent => ({
  kind: 'comment',
  at: at(minute),
  order: order++,
  id: `c${order}`,
  agentId: 'reviewer',
  path,
  line,
  text,
  exchangeId: 'xch_1',
  action: 'send_back',
})
const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')

test('interleaved edits by two agents: each line belongs to the agent who last wrote it', () => {
  const v1 = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
  const v2 = lines('a', 'b', 'c', 'B1', 'B2', 'd', 'e', 'f', 'g', 'h') // builder inserts after c
  const v3 = lines('a', 'b', 'c', 'B1', 'B2', 'd', 'e', 'f', 'g', 'R1') // reviewer replaces h
  const v4 = lines('a', 'B0', 'b', 'c', 'B1', 'B2x', 'd', 'e', 'f', 'g', 'R1') // builder: top insert + edits B2
  const { files } = replayWorkbench(
    [
      edit(0, 'builder', '', v1),
      edit(1, 'builder', v1, v2),
      edit(2, 'reviewer', v2, v3),
      edit(3, 'builder', v3, v4),
    ],
    [],
  )
  const [file] = files
  expect(file!.exact).toBe(true)
  expect(file!.lines.map((line) => `${line.n}:${line.text}:${line.by}`)).toEqual([
    '1:a:builder',
    '2:B0:builder',
    '3:b:builder',
    '4:c:builder',
    '5:B1:builder',
    '6:B2x:builder',
    '7:d:builder',
    '8:e:builder',
    '9:f:builder',
    '10:g:builder',
    '11:R1:reviewer',
  ])
  expect(file!.editedBy).toEqual(['builder', 'reviewer'])
  // The reviewer's cursor moved down with the builder's later insert at the top.
  expect(file!.cursors).toEqual([
    { agentId: 'builder', line: 6, at: at(3) },
    { agentId: 'reviewer', line: 11, at: at(2) },
  ])
})

test('lines written before the job are known only as context, with no author', () => {
  const before = lines('one', 'two', 'three', 'four', 'five')
  const after = lines('one', 'two', 'THREE', 'four', 'five')
  const { files } = replayWorkbench([edit(0, 'builder', before, after)], [])
  expect(files[0]!.lines.find((line) => line.text === 'two')?.by).toBeNull()
  expect(files[0]!.lines.find((line) => line.text === 'THREE')?.by).toBe('builder')
})

test('a note follows its line through later edits, and is outdated once the line changes or goes', () => {
  const v1 = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
  const v2 = lines('new1', 'new2', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j') // two lines above
  const v3 = lines('new1', 'new2', 'a', 'b', 'c', 'D!', 'e', 'f', 'g', 'h', 'i', 'j') // d changed
  const { files } = replayWorkbench(
    [edit(0, 'builder', '', v1), edit(2, 'builder', v1, v2), edit(4, 'builder', v2, v3)],
    [note(1, 9, 'i needs a test'), note(1, 4, 'rename d')],
  )
  const comments = Object.fromEntries(files[0]!.comments.map((c) => [c.text, c]))
  expect(comments['i needs a test']).toMatchObject({ line: 11, originalLine: 9, outdated: false })
  expect(comments['rename d']).toMatchObject({ line: null, originalLine: 4, outdated: true })
})

test('a snippet without a file position or a cut diff makes the file inexact', () => {
  const fragment: EditEvent = {
    kind: 'edit',
    at: at(0),
    order: order++,
    agentId: 'builder',
    path: 'x.ts',
    diff: '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@ fragment (file position unknown)\n-old\n+new\n',
    language: null,
  }
  expect(replayWorkbench([fragment], []).files[0]!.exact).toBe(false)
  const cut = { ...fragment, diff: '@@ -0,0 +1,2 @@\n+a\n+b\n… 40 more lines\n' }
  const replay = replayWorkbench([cut], []).files[0]!
  expect(replay.exact).toBe(false)
  expect(replay.lines).toEqual([
    { n: 1, text: 'a', by: 'builder' },
    { n: 2, text: 'b', by: 'builder' },
  ])
})

test('a whole-file write replaces what Score knew; notes on paths never edited are kept as loose notes', () => {
  const v1 = lines('a', 'b', 'c')
  const { files, looseComments } = replayWorkbench(
    [edit(0, 'builder', '', v1), edit(2, 'reviewer', '', lines('x'))],
    [note(1, 2, 'b?'), note(1, 3, 'elsewhere', 'docs/readme.md')],
  )
  expect(files[0]!.lines).toEqual([{ n: 1, text: 'x', by: 'reviewer' }])
  expect(files[0]!.comments[0]).toMatchObject({ text: 'b?', outdated: true })
  expect(looseComments).toEqual([
    expect.objectContaining({ path: 'docs/readme.md', line: 3, outdated: false }),
  ])
})

// Sonnet review (11.6a).

test('a large write replays in linear time', () => {
  const big = Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const started = performance.now()
  const replay = replayWorkbench([edit(0, 'builder', '', big)], [])
  expect(performance.now() - started).toBeLessThan(2000)
  expect(replay.files[0]!.lines).toHaveLength(5000)
  expect(replay.files[0]!.exact).toBe(false)
})

test('a second file header inside one frame is not taken for content', () => {
  const v1 = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l')
  const first = unifiedDiff(v1, lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'))
  const second = unifiedDiff(
    lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'),
    lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l'),
  )
  // watch-diff joins two operations on one path into one frame, the second keeping its header.
  const joined: EditEvent = { ...edit(1, 'builder', '', ''), diff: first + second }
  const { files } = replayWorkbench([edit(0, 'builder', '', v1), joined], [])
  expect(files[0]!.lines.map((line) => line.text)).toEqual([
    'a',
    'B',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'K',
    'l',
  ])
  expect(files[0]!.exact).toBe(true)
})

test('a fragment keeps the agent’s last known cursor and only a real fragment marker counts', () => {
  const v1 = lines('a', 'b', 'c')
  const fragment: EditEvent = {
    ...edit(1, 'builder', '', ''),
    diff: '@@ -1,1 +1,1 @@ fragment (file position unknown)\n-x\n+y\n',
  }
  const { files } = replayWorkbench([edit(0, 'builder', '', v1), fragment], [])
  expect(files[0]!.cursors[0]!.line).toBe(3)
  const heading: EditEvent = {
    ...edit(2, 'builder', '', ''),
    diff: '@@ -1,1 +1,1 @@ fragment of the docs\n-a\n+A\n',
  }
  expect(replayWorkbench([edit(0, 'builder', '', v1), heading], []).files[0]!.exact).toBe(true)
})

test('a note on a relative path finds the one edited file it names', () => {
  const v1 = lines('a', 'b')
  const { files, looseComments } = replayWorkbench(
    [edit(0, 'builder', '', v1, '/home/me/app/src/feed.ts')],
    [note(1, 2, 'b?', 'src/feed.ts')],
  )
  expect(looseComments).toEqual([])
  expect(files[0]!.comments[0]).toMatchObject({ text: 'b?', line: 2 })
})

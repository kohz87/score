import { WorkbenchSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { jobWorkbench } from '../../src/domain/exchanges/workbench.ts'
import { unifiedDiff } from '../../src/domain/line-diff.ts'
import { exchangeHarness, type Harness } from './exchange-harness.ts'

// PLAN 11.6a: the Workbench is derived from the job's editor frames and the review notes of its exchanges.

let h: Harness
let seq = 0
beforeEach(() => {
  h = exchangeHarness()
})
afterEach(() => h.close())

const workbench = () => WorkbenchSchema.parse({ asOfSeq: 0, ...jobWorkbench(h.db.sqlite, h.job()) })
const lines = (...items: string[]) => items.map((item) => `${item}\n`).join('')

function edit(
  agentId: string,
  runId: string,
  before: string,
  after: string,
  path = 'api/events.py',
) {
  h.db.sqlite
    .prepare(
      'INSERT INTO watch_frames (agent_id, seq, at, run_id, surface, payload, caption) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      agentId,
      ++seq,
      h.tick(),
      runId,
      'editor',
      JSON.stringify({ path, diff: unifiedDiff(before, after), language: 'python' }),
      `Edited ${path}`,
    )
}

test('an empty job has an empty Workbench', () => {
  expect(workbench()).toEqual({ asOfSeq: 0, files: [], looseComments: [], drafts: [], screens: [] })
})

test('two agents edit one file; the reviewer’s notes follow their lines or go outdated', () => {
  const v1 = lines(
    'def page(after):',
    '    rows = query(after)',
    '    return rows',
    '',
    'def count():',
    '    return 0',
  )
  const v2 = lines(
    'def page(after):',
    '    rows = query(after)',
    '    return rows[:50]',
    '',
    'def count():',
    '    return 0',
  )
  const v3 = lines(
    'import time',
    '',
    'def page(after):',
    '    rows = query(after, order="created_at, id")',
    '    return rows[:50]',
    '',
    'def count():',
    '    return 0',
  )
  h.ask('builder', 'Build the feed and get it reviewed.')
  const building = h.start('builder')
  edit('builder', building.runId, '', v1)
  h.act(building, { action: 'review', to: 'reviewer', note: 'Read layer is ready.' })
  h.finish(building, 'Ready.')

  const reviewing = h.start('reviewer')
  edit('reviewer', reviewing.runId, v1, v2)
  h.act(reviewing, {
    action: 'send_back',
    note: 'Same-millisecond events get skipped.',
    comments: [
      { path: 'api/events.py', line: 2, text: 'Order by (created_at, id).' },
      { path: 'api/events.py', line: 6, text: 'count() is still a stub.' },
      { path: 'api/test_events.py', line: 1, text: 'Add a test here.' },
    ],
  })
  h.finish(reviewing, 'Sent back.')

  const fixing = h.start('builder')
  edit('builder', fixing.runId, v2, v3)
  h.finish(fixing, 'Fixed.')

  const [file] = workbench().files
  expect(file!.lines.map((line) => [line.n, line.by])).toEqual([
    [1, 'builder'],
    [2, 'builder'],
    [3, 'builder'],
    [4, 'builder'],
    [5, 'reviewer'],
    [6, 'builder'],
    [7, 'builder'],
    [8, 'builder'],
  ])
  const notes = Object.fromEntries(file!.comments.map((note) => [note.text, note]))
  // Line 2 was rewritten by the fix: that note is outdated. Line 6 moved down by the two new lines at the top.
  expect(notes['Order by (created_at, id).']).toMatchObject({
    outdated: true,
    line: null,
    by: 'reviewer',
    kind: 'send_back',
  })
  expect(notes['count() is still a stub.']).toMatchObject({
    outdated: false,
    line: 8,
    originalLine: 6,
  })
  expect(notes['count() is still a stub.']!.exchangeId).toBe(h.exchanges()[0]!.id)
  expect(workbench().looseComments).toEqual([
    expect.objectContaining({ path: 'api/test_events.py', text: 'Add a test here.' }),
  ])
  expect(file!.cursors.find((cursor) => cursor.agentId === 'reviewer')?.line).toBe(5)
})

test('notes on a verdict that answered nothing are not stored', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', {
    action: 'send_back',
    note: 'Not reviewing anything.',
    comments: [{ path: 'a.py', line: 1, text: 'x' }],
  })
  expect(h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM review_comments').get()).toEqual({ n: 0 })
})

test('notes are redacted like every agent note', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', {
    action: 'approve',
    note: 'Fine.',
    comments: [
      { path: 'a.py', line: 1, text: 'Key sk-ant-api03-' + 'x'.repeat(40) + ' leaked here' },
    ],
  })
  expect(workbench().looseComments[0]!.text).not.toContain('sk-ant-api03-x')
})

test('a second review request to the same reviewer keeps its notes', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', { action: 'send_back', note: 'Fix it.' })
  h.turn('builder', {
    action: 'review',
    to: 'reviewer',
    note: 'Fixed.',
    comments: [{ path: 'a.py', line: 3, text: 'Look here first.' }],
  })
  expect(workbench().looseComments.map((note) => note.text)).toEqual(['Look here first.'])
})

test('a note on a credential file keeps only that it exists', () => {
  h.ask('builder', 'Build it.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Ready.' })
  h.turn('reviewer', {
    action: 'send_back',
    note: 'No.',
    comments: [{ path: 'app/.env', line: 2, text: 'DB_PASSWORD=hunter2 is wrong' }],
  })
  expect(workbench().looseComments[0]!.text).toBe('A note on a credential file (hidden).')
})

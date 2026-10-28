import { JobResultsSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { jobResults } from '../../src/domain/exchanges/results.ts'
import { exchangeHarness, type Harness } from './exchange-harness.ts'

// PLAN 11.2b: a job's results are derived from what Score records for its turns.

let h: Harness
beforeEach(() => {
  h = exchangeHarness()
})
afterEach(() => h.close())

const results = () => JobResultsSchema.parse({ asOfSeq: 0, ...jobResults(h.db.sqlite, h.job()) })

/** An agent message in the job with extra parts (as a finished turn's file and attachment parts). */
function parts(agentId: string, extra: unknown[]) {
  const at = h.tick()
  h.db.sqlite
    .prepare(
      `INSERT INTO messages (id, room_id, job_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at)
       VALUES (?, 'team', ?, 'agent', ?, '[]', ?, '[]', 0, ?, ?)`,
    )
    .run(`x${at}`, h.job(), agentId, JSON.stringify(extra), at, at)
}

function frame(
  agentId: string,
  runId: string,
  seq: number,
  surface: string,
  payload: unknown,
  caption: string,
) {
  h.db.sqlite
    .prepare(
      'INSERT INTO watch_frames (agent_id, seq, at, run_id, surface, payload, caption) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(agentId, seq, h.tick(), runId, surface, JSON.stringify(payload), caption)
}

test('an empty job has no results', () => {
  expect(results()).toEqual({ asOfSeq: 0, items: [], screens: [] })
})

test('the change card: files per path with who touched them, and what the reviews said', () => {
  h.ask('builder', 'Build the feed and get it reviewed.')
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Read layer is ready.' })
  parts('builder', [{ kind: 'file', path: 'api/events.py', added: 12, removed: 2 }])
  h.turn('reviewer', {
    action: 'send_back',
    note: 'Events in the same millisecond get skipped.\nUse (created_at, id).',
  })
  expect(results().items[0]).toMatchObject({ kind: 'change', state: 'sent_back' })
  parts('builder', [
    { kind: 'file', path: 'api/events.py', added: 3, removed: 1 },
    { kind: 'file', path: 'api/test_events.py', added: 20, removed: 0 },
  ])
  h.turn('builder', { action: 'review', to: 'reviewer', note: 'Fixed, with a test.' })
  h.turn('reviewer', { action: 'approve', note: 'Looks right.' })
  const [change] = results().items
  expect(change).toEqual({
    kind: 'change',
    id: `change:${h.job()}`,
    title: '#team',
    authors: ['builder'],
    state: 'approved',
    whatChanged: [
      { text: 'Events in the same millisecond get skipped.', by: 'reviewer', caught: true },
      { text: 'Approved by reviewer', by: 'reviewer', caught: false },
    ],
    files: [
      { path: 'api/events.py', added: 15, removed: 3, by: ['builder'] },
      { path: 'api/test_events.py', added: 20, removed: 0, by: ['builder'] },
    ],
    at: expect.any(String),
  })
})

test('the preview is the newest browser frame of the job’s runs; screens are each agent’s newest frame', () => {
  h.ask('builder', 'Build it.')
  const running = h.start('builder')
  frame(
    'builder',
    running.runId,
    1,
    'terminal',
    { cwd: '~/app', command: 'pnpm test', output: 'ok', status: 'ok' },
    'Ran the tests',
  )
  frame(
    'builder',
    running.runId,
    2,
    'browser',
    { url: 'http://localhost:5173/feed', title: 'Feed', imageUrl: null },
    'Opened the feed',
  )
  // A frame of a run outside this job is not this job's.
  frame(
    'designer',
    'run-elsewhere',
    1,
    'browser',
    { url: 'http://other', title: null, imageUrl: null },
    'Elsewhere',
  )
  const { items, screens } = results()
  expect(items).toEqual([
    {
      kind: 'preview',
      id: 'preview:builder:2',
      agentId: 'builder',
      url: 'http://localhost:5173/feed',
      title: 'Feed',
      imageUrl: null,
      live: true,
      at: expect.any(String),
    },
  ])
  expect(screens).toEqual([
    {
      agentId: 'builder',
      seq: 2,
      surface: 'browser',
      caption: 'Opened the feed',
      live: true,
      at: expect.any(String),
    },
  ])
  h.finish(running, 'Done.')
  expect(results().items[0]).toMatchObject({ kind: 'preview', live: false })
})

test('3.14: agents that edit with their own tools show as changes from the editor frames, with diff counts', () => {
  h.ask('builder', 'Fix the map.')
  const running = h.start('builder')
  frame(
    'builder',
    running.runId,
    1,
    'editor',
    {
      path: 'docs/MAP.md',
      diff: '--- a/docs/MAP.md\n+++ b/docs/MAP.md\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same',
      language: 'markdown',
    },
    'Edited MAP.md',
  )
  const [change] = results().items
  expect(change).toMatchObject({
    kind: 'change',
    authors: ['builder'],
    files: [{ path: 'docs/MAP.md', added: 2, removed: 1, by: ['builder'] }],
  })
})

test('drafts are the documents and workspace files agents attached in the job', () => {
  parts('designer', [
    {
      kind: 'document',
      mediaId: 'med1',
      name: 'Empty states.pdf',
      contentType: 'application/pdf',
      size: 10,
    },
    { kind: 'workspace', agentId: 'designer', path: 'drafts/announcement.png' },
  ])
  expect(results().items.map((item) => item.kind === 'draft' && [item.title, item.target])).toEqual(
    [
      ['Empty states.pdf', { kind: 'document', mediaId: 'med1' }],
      ['announcement.png', { kind: 'workspace', path: 'drafts/announcement.png' }],
    ],
  )
})

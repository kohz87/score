import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readProfileSessionCosts, readReportFacts } from '../../../src/hermes/live/report-facts.ts'
import { createFixtureHome, insertTask } from '../../fixtures/hermes/sqlite-fixture.ts'

let fixture: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  fixture = createFixtureHome()
})
afterEach(() => fixture.close())

function addSession(
  db: ReturnType<typeof fixture.build>['db'],
  id: string,
  startedAt: number,
  actual: number | null,
  estimated: number | null,
) {
  db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, actual_cost_usd, estimated_cost_usd)
     VALUES (?, 'cli', 'example-model', ?, ?, ?)`,
  ).run(id, startedAt, actual, estimated)
}

test('spend sums billed cost, falls back to the estimate, and ignores sessions outside the window', () => {
  mkdirSync(`${fixture.home}/profiles/builder`, { recursive: true })
  const builder = fixture.build('state', 'profiles/builder/state.db')
  addSession(builder.db, 's1', 1000, 0.5, 0.4)
  addSession(builder.db, 's2', 1500, null, 0.25)
  addSession(builder.db, 's4', 9000, 7, 7)
  addSession(builder.db, 's5', 10, 7, 7)
  builder.db.prepare("UPDATE sessions SET ended_at = 20 WHERE id = 's5'").run()
  const facts = readReportFacts(
    { from: 1_000_000, to: 2_000_000, agentIds: ['builder', 'designer', '../evil'] },
    fixture.home,
  )
  // designer has no state.db and the invalid name is never turned into a path: both unavailable, not zero.
  expect(facts.spendUsd).toEqual({ builder: 0.75, designer: null, '../evil': null })
  expect(facts.tasks).toEqual([])
})

test('the default profile reads state.db at the Hermes home, and the file is never modified', () => {
  const state = fixture.build('state')
  addSession(state.db, 's1', 1200, 1.25, null)
  const facts = readReportFacts(
    { from: 1_000_000, to: 2_000_000, agentIds: ['default'] },
    fixture.home,
  )
  expect(facts.spendUsd).toEqual({ default: 1.25 })
})

test('kanban tasks carry completion time, parent flag and the review/block events in order', () => {
  const kanban = fixture.build('kanban')
  insertTask(kanban.db, 't_a')
  insertTask(kanban.db, 't_b')
  kanban.db.prepare("UPDATE tasks SET status = 'done', completed_at = 5000 WHERE id = 't_a'").run()
  kanban.db.prepare("INSERT INTO task_links (parent_id, child_id) VALUES ('t_a', 't_b')").run()
  const event = kanban.db.prepare(
    'INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, ?, NULL, ?)',
  )
  event.run('t_a', 'review_requested', 3000)
  event.run('t_a', 'changes_requested', 3500)
  event.run('t_a', 'created', 100)
  event.run('t_b', 'promoted', 5001)
  const { tasks } = readReportFacts({ from: 0, to: 1, agentIds: [] }, fixture.home)
  expect(tasks).toEqual([
    {
      id: 't_a',
      assignee: 'builder',
      status: 'done',
      createdAt: 2_000_000,
      completedAt: 5_000_000,
      hasParents: false,
      events: [
        { id: 1, kind: 'review_requested', at: 3_000_000, actor: null },
        { id: 2, kind: 'changes_requested', at: 3_500_000, actor: null },
      ],
    },
    {
      id: 't_b',
      assignee: 'builder',
      status: 'todo',
      createdAt: 2_000_000,
      completedAt: null,
      hasParents: true,
      events: [{ id: 4, kind: 'promoted', at: 5_001_000, actor: null }],
    },
  ])
})

test('events keep their ids in id order and name the implementer of a review', () => {
  const kanban = fixture.build('kanban')
  insertTask(kanban.db, 't_a')
  const event = kanban.db.prepare(
    'INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
  )
  // Same second, inserted in id order: ids, not timestamps, decide which closure follows which request.
  event.run(
    't_a',
    'review_requested',
    JSON.stringify({ implementer: 'builder', reviewer: 'reviewer' }),
    3000,
  )
  event.run('t_a', 'changes_requested', JSON.stringify({ implementer: 'builder' }), 3000)
  event.run('t_a', 'review_requested', '{not json', 3000)
  const { tasks } = readReportFacts({ from: 0, to: 1, agentIds: [] }, fixture.home)
  expect(tasks[0]!.events.map((e) => [e.kind, e.actor])).toEqual([
    ['review_requested', 'builder'],
    ['changes_requested', 'builder'],
    ['review_requested', null],
  ])
  expect(tasks[0]!.events.map((e) => e.id)).toEqual(
    [...tasks[0]!.events.map((e) => e.id)].sort((a, b) => a - b),
  )
})

test('unknown session cost and sessions carried over from before the window make spend unknown', () => {
  mkdirSync(`${fixture.home}/profiles/builder`, { recursive: true })
  mkdirSync(`${fixture.home}/profiles/designer`, { recursive: true })
  const builder = fixture.build('state', 'profiles/builder/state.db')
  addSession(builder.db, 's1', 1500, 0.5, null)
  addSession(builder.db, 's2', 1600, null, null)
  const designer = fixture.build('state', 'profiles/designer/state.db')
  addSession(designer.db, 'd1', 500, 2, null)
  designer.db.prepare("UPDATE sessions SET last_activity_at = 1500 WHERE id = 'd1'").run()
  const facts = readReportFacts(
    { from: 1_000_000, to: 2_000_000, agentIds: ['builder', 'designer'] },
    fixture.home,
  )
  expect(facts.spendUsd).toEqual({ builder: null, designer: null })
})

test('session costs list recently active sessions with cumulative cost in epoch ms', () => {
  const state = fixture.build('state')
  addSession(state.db, 'old', 10, 1, null)
  addSession(state.db, 'new', 5000, null, 0.25)
  const costs = readProfileSessionCosts(
    { sinceMs: 1_000_000, agentIds: ['default', 'designer', '../evil'] },
    fixture.home,
  )
  expect(costs).toEqual({
    default: [{ sessionId: 'new', startedAt: 5_000_000, costUsd: 0.25, estimated: true }],
  })
})

test('cache tokens: read share of prompt tokens, unknown when none were recorded or the profile is unreadable', () => {
  mkdirSync(`${fixture.home}/profiles/builder`, { recursive: true })
  mkdirSync(`${fixture.home}/profiles/designer`, { recursive: true })
  const builder = fixture.build('state', 'profiles/builder/state.db')
  const designer = fixture.build('state', 'profiles/designer/state.db')
  const tokens = (
    db: typeof builder.db,
    id: string,
    at: number,
    input: number,
    read: number,
    write: number,
  ) => {
    addSession(db, id, at, null, 0.1)
    db.prepare(
      'UPDATE sessions SET input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?',
    ).run(input, read, write, id)
  }
  tokens(builder.db, 's1', 1200, 100, 600, 100)
  tokens(builder.db, 's2', 1300, 100, 0, 100)
  tokens(designer.db, 'd1', 1200, 500, 0, 0) // a provider with no cache tokens is not a 0% hit rate
  const facts = readReportFacts(
    { from: 1_000_000, to: 2_000_000, agentIds: ['builder', 'designer', 'ghost'] },
    fixture.home,
  )
  expect(facts.cache).toEqual({
    builder: { read: 600, total: 1000 },
    designer: null,
    ghost: null,
  })
})

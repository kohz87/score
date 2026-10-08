import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readReportFacts } from '../../../src/hermes/live/report-facts.ts'
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
        { kind: 'review_requested', at: 3_000_000 },
        { kind: 'changes_requested', at: 3_500_000 },
      ],
    },
    {
      id: 't_b',
      assignee: 'builder',
      status: 'todo',
      createdAt: 2_000_000,
      completedAt: null,
      hasParents: true,
      events: [{ kind: 'promoted', at: 5_001_000 }],
    },
  ])
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

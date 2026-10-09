import type { TaskDetail } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renameSync } from 'node:fs'
import { z } from 'zod'
import {
  attemptSummary,
  currentAttemptsOfTask,
  listAttempts,
} from '../../../src/domain/kanban-attempts.ts'
import { buildLanes } from '../../../src/domain/lanes.ts'
import { computeReports } from '../../../src/domain/reports.ts'
import { projectTask } from '../../../src/domain/tasks.ts'
import type { HermesPort } from '../../../src/hermes/index.ts'
import { LiveTasks } from '../../../src/hermes/live/tasks.ts'
import { createBriefControl } from '../../../src/http/brief-control.ts'
import { createTaskHolds } from '../../../src/http/task-holds.ts'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'
import { seedAttempt, seedHistory, withFlag } from '../../helpers/kanban-attempts-seed.ts'

// Audit wave 5, fix batch F.
let h: Harness
beforeEach(() => {
  withFlag(true)
  h = createHarness()
  h.score.sqlite.exec('PRAGMA foreign_keys = OFF')
})
afterEach(async () => {
  withFlag(false)
  await h.close()
})

function taskDetail(id: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id,
    key: id,
    title: `Task ${id}`,
    column: 'planned',
    hermesStatus: 'ready',
    assignee: 'builder',
    reviewer: null,
    roomId: null,
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: '2026-10-09T10:00:00.000Z',
    body: '',
    createdBy: 'lead',
    steps: [],
    activity: [],
    pendingApproval: null,
    dependsOn: [],
    blocks: [],
    runIds: [],
    ...overrides,
  }
}

const NOW = '2026-10-09T10:00:00.000Z'
const addBrief = (id = 'b1') =>
  h.score.sqlite
    .prepare(
      "INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, 'room', 'B', ?, 'you')",
    )
    .run(id, NOW)
const link = (task: string, history: string | null, brief = 'b1') =>
  h.score.sqlite
    .prepare(
      "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at, history_id) VALUES (?, ?, 'assign', ?, ?)",
    )
    .run(brief, task, NOW, history)
const holdRows = () =>
  z
    .array(z.object({ task_id: z.string() }))
    .parse(h.score.sqlite.prepare('SELECT task_id FROM brief_paused_tasks').all())
    .map((row) => row.task_id)

describe('pausing a brief', () => {
  function control() {
    const taskAction = vi.fn(async () => ({ hermesStatus: 'scheduled' }))
    const port = {
      getTask: async (id: string) => taskDetail(id),
      taskAction,
    } as unknown as HermesPort
    const holds = createTaskHolds({ port, db: h.score, ingest: h.ingest })
    return {
      taskAction,
      control: createBriefControl({ port, db: h.score, ingest: h.ingest, holds }),
    }
  }

  test('a link from a replaced history is display-only: Pause does not hold or park the new history’s task', async () => {
    seedHistory(h.score.sqlite, { history: 'kh_old', state: 'closed' })
    seedHistory(h.score.sqlite, { history: 'kh_new', state: 'active' })
    addBrief()
    h.score.tx((sqlite) => projectTask(sqlite, taskDetail('t_a')))
    link('t_a', 'kh_old')
    const { control: briefs, taskAction } = control()
    await briefs.pause('b1')
    expect(holdRows()).toEqual([])
    expect(taskAction).not.toHaveBeenCalled()
  })

  test('a current link to a current projection is still held', async () => {
    seedHistory(h.score.sqlite, { history: 'kh_new', state: 'active' })
    addBrief()
    h.score.tx((sqlite) => projectTask(sqlite, taskDetail('t_a')))
    link('t_a', 'kh_new')
    const { control: briefs, taskAction } = control()
    await briefs.pause('b1')
    expect(holdRows()).toEqual(['t_a'])
    expect(taskAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule' }))
  })
})

describe('hold actions revalidate ownership after reads', () => {
  const pauseSource = () =>
    h.score.sqlite.exec("UPDATE kanban_histories SET state = 'paused' WHERE state = 'active'")
  function world(state: string) {
    seedHistory(h.score.sqlite, { history: 'kh_new', state: 'active' })
    h.score.sqlite
      .prepare(
        `INSERT INTO brief_paused_tasks (brief_id, task_id, blocked_at, state, history_id)
         VALUES ('b1', 't_a', ?, ?, 'kh_new')`,
      )
      .run(NOW, state)
    const taskAction = vi.fn(async () => ({ hermesStatus: 'scheduled' }))
    const port = {
      getTask: async (id: string) => {
        pauseSource()
        return taskDetail(id, { hermesStatus: state === 'held' ? 'scheduled' : 'ready' })
      },
      taskAction,
    } as unknown as HermesPort
    return { taskAction, holds: createTaskHolds({ port, db: h.score, ingest: h.ingest }) }
  }

  test('Resume does not unblock or delete a hold whose history went inert during the read', async () => {
    const { holds, taskAction } = world('held')
    expect(await holds.release({ kind: 'brief', id: 'b1' })).toEqual([])
    expect(taskAction).not.toHaveBeenCalled()
    expect(holdRows()).toEqual(['t_a'])
  })

  test('Pause does not park or confirm a hold whose history went inert during the read', async () => {
    const { holds, taskAction } = world('pending')
    expect(await holds.apply({ kind: 'brief', id: 'b1' }, () => true)).toEqual([])
    expect(taskAction).not.toHaveBeenCalled()
    expect(h.score.sqlite.prepare('SELECT state FROM brief_paused_tasks').get()).toEqual({
      state: 'pending',
    })
  })
})

describe('task ingestion follows the attempts history', () => {
  const activity = () =>
    z
      .array(z.object({ type: z.string(), data: z.string() }))
      .parse(h.score.sqlite.prepare('SELECT type, data FROM events ORDER BY seq').all())
      .filter((event) => event.type === 'task.activity')
      .map((event) => (JSON.parse(event.data) as { taskId: string }).taskId)

  test('a restored board whose events fall below the old cursor is ingested again', async () => {
    for (const id of ['t_1', 't_2', 't_3', 't_4', 't_5']) h.board.task(id)
    const tasks = new LiveTasks(h.score, h.ingest, h.home, { kanbanAttempts: true })
    for (let index = 0; index < 3; index++) await tasks.poll()
    const before = activity().length
    expect(before).toBe(5)
    // In-place restore: event ids start over, below the saved cursor (5).
    h.board.db.exec(
      "DELETE FROM task_events; DELETE FROM sqlite_sequence WHERE name = 'task_events'; DELETE FROM tasks",
    )
    h.board.task('t_new')
    for (let index = 0; index < 4; index++) await tasks.poll()
    await tasks.close()
    expect(h.histories().map((row) => row.state)).toEqual(['closed', 'active'])
    expect(activity().slice(before)).toContain('t_new')
  })
})

describe('upgrade snapshot of legacy links', () => {
  test('is complete before the first flag-on task reconciliation rewrites the projection', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    h.score.tx((sqlite) => projectTask(sqlite, taskDetail('t_a', { runIds: ['99'] })))
    const tasks = new LiveTasks(h.score, h.ingest, h.home, { kanbanAttempts: true })
    await tasks.poll()
    await tasks.close()
    const links = h.score.sqlite
      .prepare('SELECT task_id, legacy_id FROM kanban_upgrade_links ORDER BY legacy_id')
      .all()
    expect(links).toEqual([{ task_id: 't_a', legacy_id: '99' }])
  })
})

describe('resumed observation', () => {
  test('an attempt observed again is open in listings and summaries, with the unobserved gap kept', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make({ unreadableAfter: 2 })
    await h.poll(coordinator, 3)
    renameSync(h.board.path, `${h.board.path}.away`)
    await h.poll(coordinator, 3)
    const boundary = h.attempts()[0]!.observation_ended_at!
    renameSync(`${h.board.path}.away`, h.board.path)
    await h.poll(coordinator, 3)
    const [attempt] = listAttempts(h.score.sqlite, {
      since: new Date(h.clock.ms + 1000).toISOString(),
      until: new Date(h.clock.ms + 2000).toISOString(),
    })
    expect(attempt).toBeDefined()
    expect(attemptSummary(attempt!).observationEndedAt).toBeNull()
    expect(attempt!.observations).toHaveLength(2)
    expect(attempt!.observations[0]!.endedAt).toBe(boundary)
    expect(attempt!.observations[1]!.endedAt).toBeNull()
    // A window wholly inside the unobserved gap does not contain the attempt.
    const gap = attempt!.observations
    const inside = new Date(
      (Date.parse(gap[0]!.endedAt!) + Date.parse(gap[1]!.startedAt)) / 2,
    ).toISOString()
    expect(listAttempts(h.score.sqlite, { since: inside, until: inside })).toEqual([])
  })

  test('lanes draw one block per observed stretch and reports count only observed time', () => {
    const observed = [
      { startedAt: '2026-10-09T10:00:00.000Z', endedAt: '2026-10-09T10:01:00.000Z' },
      { startedAt: '2026-10-09T10:02:00.000Z', endedAt: null },
    ]
    const lanes = buildLanes({
      agentIds: ['builder'],
      runs: [],
      tasks: [],
      attempts: [
        {
          id: 'kr_1',
          agentId: 'builder',
          role: 'implementer',
          startedAt: '2026-10-09T10:00:00.000Z',
          endedAt: null,
          observationEndedAt: null,
          observed,
          evidence: 'proven',
          attemptNumber: 1,
          taskId: 't',
          taskTitle: 'T',
        },
      ],
      hops: [],
      waitingRunIds: [],
      from: '2026-10-09T09:00:00.000Z',
      to: '2026-10-09T11:00:00.000Z',
      now: '2026-10-09T10:05:00.000Z',
    })
    const blocks = lanes.lanes[0]!.blocks
    expect(blocks.map((block) => [block.state, block.end])).toEqual([
      ['done', '2026-10-09T10:01:00.000Z'],
      ['working', null],
    ])
    expect(blocks[0]!.observationEndedAt).toBe('2026-10-09T10:01:00.000Z')

    const report = computeReports({
      range: 'today',
      now: Date.parse('2026-10-09T10:05:00.000Z'),
      tz: 'UTC',
      agentIds: ['builder'],
      runs: [],
      approvals: [],
      facts: { tasks: [], spendUsd: { builder: 0 } },
      attempts: [
        {
          agentId: null,
          startedAt: '2026-10-09T10:00:00.000Z',
          endedAt: null,
          evidence: 'proven',
          observed,
        },
      ],
    })
    // 1 minute + 3 minutes observed; the minute in between was not.
    expect(report.unattributed).toEqual({ runs: 1, workingSec: 240 })
  })
})

describe('copied attempts', () => {
  test('contradicting evidence (lock, profile) is a different attempt, not a copy', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1', profile: 'builder' })
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    const startedAt = h.attempts()[0]!.started_at
    // Restore: another worker holds the same numeric id, task and start second.
    h.board.db.exec(
      "DELETE FROM task_events; DELETE FROM sqlite_sequence WHERE name = 'task_events'",
    )
    h.board.db.exec("UPDATE task_runs SET claim_lock = 'host:2', profile = 'reviewer'")
    h.board.event('t_a', 'created', { by: 'lead' })
    await h.poll(coordinator, 4)
    const rows = h.attempts()
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.started_at === startedAt)).toBe(true)
    expect(rows.map((row) => row.copied_from)).toEqual([null, null])
    expect(
      listAttempts(h.score.sqlite, {
        since: new Date(0).toISOString(),
        until: new Date(h.clock.ms).toISOString(),
        excludeCopies: true,
      }),
    ).toHaveLength(2)
  })

  test('a genuine copy stays visible to its task and carries the later observations in aggregates', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    h.board.db.exec(
      "DELETE FROM task_events; DELETE FROM sqlite_sequence WHERE name = 'task_events'",
    )
    h.board.event('t_a', 'created', { by: 'lead' })
    await h.poll(coordinator, 4)
    const rows = h.attempts()
    expect(rows).toHaveLength(2)
    expect(rows[1]!.copied_from).toBe(rows[0]!.id)
    const current = currentAttemptsOfTask(h.score.sqlite, 't_a', h.clock.ms)
    expect(current.map((attempt) => attempt.id)).toEqual([rows[1]!.id])
    // Aggregates count it once, through the row that carries the later state.
    const all = listAttempts(h.score.sqlite, {
      since: new Date(0).toISOString(),
      until: new Date(h.clock.ms).toISOString(),
      excludeCopies: true,
    })
    expect(all.map((attempt) => attempt.id)).toEqual([rows[1]!.id])
    expect(all[0]!.observations.length).toBeGreaterThanOrEqual(1)
  })
})

void seedAttempt

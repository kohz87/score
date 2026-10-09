import type { TaskDetail } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { projectTask } from '../../../src/domain/tasks.ts'
import type { HermesPort } from '../../../src/hermes/index.ts'
import { LiveTasks } from '../../../src/hermes/live/tasks.ts'
import { createBriefControl } from '../../../src/http/brief-control.ts'
import { createTaskHolds } from '../../../src/http/task-holds.ts'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'
import { seedHistory, withFlag } from '../../helpers/kanban-attempts-seed.ts'

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

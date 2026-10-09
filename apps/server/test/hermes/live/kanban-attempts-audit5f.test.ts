import type { TaskDetail } from '@score/contract'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { projectTask } from '../../../src/domain/tasks.ts'
import type { HermesPort } from '../../../src/hermes/index.ts'
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

void seedAttempt

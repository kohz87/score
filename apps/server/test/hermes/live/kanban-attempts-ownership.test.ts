import { StreamEventSchema, type TaskDetail } from '@score/contract'
import { renameSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { approvalView, readApprovalRow } from '../../../src/domain/approval-store.ts'
import { recordKanbanDenial } from '../../../src/domain/kanban-denials.ts'
import { recordHolds } from '../../../src/domain/holds.ts'
import { projectTask } from '../../../src/domain/tasks.ts'
import type { HermesPort } from '../../../src/hermes/index.ts'
import { createTaskHolds } from '../../../src/http/task-holds.ts'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'
import { seedHistory, withFlag } from '../../helpers/kanban-attempts-seed.ts'

let h: Harness
beforeEach(() => {
  withFlag(true)
  h = createHarness()
  // Briefs and rooms are not what these tests are about.
  h.score.sqlite.exec('PRAGMA foreign_keys = OFF')
})
afterEach(async () => {
  withFlag(false)
  await h.close()
})

const events = () =>
  z
    .array(z.object({ seq: z.int(), ts: z.string(), type: z.string(), data: z.string() }))
    .parse(h.score.sqlite.prepare('SELECT seq, ts, type, data FROM events ORDER BY seq').all())
    .map((row) => StreamEventSchema.parse({ ...row, data: JSON.parse(row.data) }))
const after = () => new Date((h.board.clock + 5) * 1000).toISOString()

describe('attempt.updated', () => {
  test('is emitted in the transaction that created, closed or bounded an attempt', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make({ unreadableAfter: 2 })
    await h.poll(coordinator, 3)
    const updates = () => events().filter((event) => event.type === 'attempt.updated')
    expect(updates()).toHaveLength(1)
    expect(updates()[0]!.data).toMatchObject({
      kind: 'kanban',
      agentId: 'builder',
      status: 'running',
      endedAt: null,
      observationEndedAt: null,
      taskId: 't_a',
      order: [new Date(h.board.clock * 1000).toISOString(), run],
      tools: null,
      session: null,
      model: null,
    })
    // Polling an unchanged board emits nothing.
    await h.poll(coordinator, 2)
    expect(updates()).toHaveLength(1)
    h.board.tick(30)
    h.board.end('t_a', { outcome: 'completed' })
    await h.poll(coordinator, 2)
    expect(updates()).toHaveLength(2)
    expect(updates()[1]!.data).toMatchObject({ status: 'completed', closureReason: 'completed' })

    // An open attempt that stops being observed gets a boundary event, not an end time.
    h.board.task('t_b')
    h.board.claim('t_b', { lock: 'host:2' })
    await h.poll(coordinator, 2)
    const before = updates().length
    renameSync(h.board.path, `${h.board.path}.away`)
    await h.poll(coordinator, 2)
    const paused = updates().slice(before)
    expect(paused).toHaveLength(1)
    expect(paused[0]!.data).toMatchObject({ status: 'running', endedAt: null })
    expect(
      (paused[0]!.data as { observationEndedAt: string | null }).observationEndedAt,
    ).not.toBeNull()
  })
})

describe('conservative upgrade of ownership', () => {
  const link = (task: string, at: string, brief = 'b1') => {
    h.score.sqlite.exec('PRAGMA foreign_keys = OFF')
    h.score.sqlite
      .prepare(
        "INSERT OR IGNORE INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, 'room', 'B', ?, 'you')",
      )
      .run(brief, at)
    h.score.sqlite
      .prepare(
        "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES (?, ?, 'assign', ?)",
      )
      .run(brief, task, at)
  }
  const stamps = (table: string, key: string, column = 'history_id') =>
    Object.fromEntries(
      z
        .array(z.object({ k: z.string(), h: z.string().nullable() }))
        .parse(h.score.sqlite.prepare(`SELECT ${key} AS k, ${column} AS h FROM ${table}`).all())
        .map((row) => [row.k, row.h]),
    )

  test('a present task is assigned to the current history; a missing task and a reused id stay unqualified', async () => {
    h.board.task('t_present')
    h.board.task('t_reused')
    const later = new Date((h.board.clock + 100) * 1000).toISOString()
    // Linked before the board's task existed: the id was reused by a different task.
    const earlier = new Date((h.board.clock - 100) * 1000).toISOString()
    link('t_present', later)
    link('t_missing', later)
    link('t_reused', earlier)
    h.score.sqlite
      .prepare("INSERT INTO task_rooms (task_id, room_id, created_at) VALUES ('t_present', 'r', ?)")
      .run(later)
    h.score.sqlite
      .prepare("INSERT INTO task_rooms (task_id, room_id, created_at) VALUES ('t_missing', 'r', ?)")
      .run(later)
    h.score.sqlite
      .prepare(
        "INSERT INTO brief_paused_tasks (brief_id, task_id, blocked_at, state) VALUES ('b1', 't_present', ?, 'held')",
      )
      .run(later)
    h.score.sqlite
      .prepare(
        "INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at, state) VALUES ('builder', 't_missing', ?, 'held')",
      )
      .run(later)
    // Denials written before qualification existed.
    withFlag(false)
    h.score.tx((sqlite) => {
      for (const taskId of ['t_present', 't_missing'])
        recordKanbanDenial(
          sqlite,
          { patternKey: 'rm', commandDigest: 'a'.repeat(64), taskId, runId: null },
          { profile: 'builder', id: 'p1', incarnation: 'i1' },
          'rm -rf /',
          later,
        )
    })
    withFlag(true)

    const coordinator = h.make()
    await h.poll(coordinator, 4)
    const history = h.histories()[0]!.id
    expect(stamps('brief_tasks', 'task_id')).toEqual({
      t_present: history,
      t_missing: null,
      t_reused: null,
    })
    expect(stamps('task_rooms', 'task_id')).toEqual({ t_present: history, t_missing: null })
    expect(stamps('brief_paused_tasks', 'task_id')).toEqual({ t_present: history })
    expect(stamps('agent_paused_tasks', 'task_id')).toEqual({ t_missing: null })
    expect(stamps('approvals', 'kanban_task_id', 'kanban_history_id')).toEqual({
      t_present: history,
      t_missing: null,
    })
    // The pass ran once: nothing assigned by a later poll, and the marker is set.
    expect(
      z
        .object({ ownership_qualified_at: z.string().nullable() })
        .parse(h.score.sqlite.prepare('SELECT ownership_qualified_at FROM kanban_histories').get())
        .ownership_qualified_at,
    ).not.toBeNull()
    h.board.task('t_missing')
    await h.poll(coordinator, 3)
    expect(stamps('brief_tasks', 'task_id')['t_missing']).toBeNull()
  })

  test('a new association is stamped with the live history; with attempts off nothing is stamped', async () => {
    const coordinator = h.make()
    h.board.task('t_a')
    await h.poll(coordinator, 2)
    const history = h.histories()[0]!.id
    h.score.tx((sqlite) => recordHolds(sqlite, { kind: 'brief', id: 'b1' }, ['t_a'], after()))
    expect(stamps('brief_paused_tasks', 'task_id')).toEqual({ t_a: history })
    withFlag(false)
    h.score.tx((sqlite) => recordHolds(sqlite, { kind: 'brief', id: 'b2' }, ['t_b'], after()))
    expect(
      z
        .object({ history_id: z.string().nullable() })
        .parse(
          h.score.sqlite
            .prepare("SELECT history_id FROM brief_paused_tasks WHERE brief_id = 'b2'")
            .get(),
        ).history_id,
    ).toBeNull()
  })

  test('a replaced history leaves old stamps behind (inert) and unstamps the projections', async () => {
    h.board.task('t_a')
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    const first = h.histories()[0]!.id
    h.score.tx((sqlite) => {
      projectTask(sqlite, taskDetail('t_a'))
      recordHolds(sqlite, { kind: 'brief', id: 'b1' }, ['t_a'], after())
    })
    expect(stamps('task_projections', 'id')).toEqual({ t_a: first })
    // The board is restored from before: allocation marks fall below the saved ones.
    h.board.db.exec(
      "DELETE FROM task_events; DELETE FROM sqlite_sequence WHERE name = 'task_events'",
    )
    await h.poll(coordinator, 3)
    const histories = h.histories()
    expect(histories.map((row) => row.state)).toEqual(['closed', 'active'])
    expect(stamps('task_projections', 'id')).toEqual({ t_a: null })
    expect(stamps('brief_paused_tasks', 'task_id')).toEqual({ t_a: first })
  })
})

function taskDetail(id: string, overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id,
    key: id,
    title: `Task ${id}`,
    column: 'planned',
    hermesStatus: 'scheduled',
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

describe('inert holds', () => {
  function holdWorld(state: 'active' | 'paused' = 'active') {
    seedHistory(h.score.sqlite, { state })
    seedHistory(h.score.sqlite, { history: 'kh_old', state: 'closed' })
    const insert = h.score.sqlite.prepare(
      `INSERT INTO brief_paused_tasks (brief_id, task_id, blocked_at, state, history_id)
       VALUES ('b1', ?, '2026-10-09T10:00:00.000Z', ?, ?)`,
    )
    insert.run('t_current', 'held', 'kh_test')
    insert.run('t_unqualified', 'held', null)
    insert.run('t_old', 'held', 'kh_old')
    const taskAction = vi.fn(async () => ({ hermesStatus: 'ready' }))
    const port = {
      getTask: async (id: string) => taskDetail(id),
      taskAction,
    } as unknown as HermesPort
    const inert: { owner: unknown; taskIds: string[] }[] = []
    const holds = createTaskHolds({
      port,
      db: h.score,
      ingest: h.ingest,
      onInert: (owner, taskIds) => inert.push({ owner, taskIds }),
    })
    return { holds, taskAction, inert }
  }
  const remaining = () =>
    z
      .array(z.object({ task_id: z.string() }))
      .parse(h.score.sqlite.prepare('SELECT task_id FROM brief_paused_tasks ORDER BY rowid').all())
      .map((row) => row.task_id)

  test('release unparks only the current hold; inert ones stay and are reported, not failures', async () => {
    const { holds, taskAction, inert } = holdWorld()
    const failed = await holds.release({ kind: 'brief', id: 'b1' })
    expect(failed).toEqual([])
    expect(taskAction).toHaveBeenCalledTimes(1)
    expect(taskAction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't_current', action: 'unblock' }),
    )
    expect(remaining()).toEqual(['t_unqualified', 't_old'])
    expect(inert).toEqual([
      { owner: { kind: 'brief', id: 'b1' }, taskIds: ['t_unqualified', 't_old'] },
    ])
  })

  test('while the source is paused nothing is released and every hold is inert', async () => {
    const { holds, taskAction, inert } = holdWorld('paused')
    expect(await holds.release({ kind: 'brief', id: 'b1' })).toEqual([])
    expect(taskAction).not.toHaveBeenCalled()
    expect(remaining()).toEqual(['t_current', 't_unqualified', 't_old'])
    expect(inert[0]!.taskIds).toEqual(['t_current', 't_unqualified', 't_old'])
  })

  test('with attempts off every hold releases as before and nothing is reported', async () => {
    withFlag(false)
    const { holds, taskAction, inert } = holdWorld()
    await holds.release({ kind: 'brief', id: 'b1' })
    expect(taskAction).toHaveBeenCalledTimes(3)
    expect(remaining()).toEqual([])
    expect(inert).toEqual([])
  })

  test('applying pending holds parks only current ones', async () => {
    const { taskAction } = holdWorld()
    h.score.sqlite.exec("UPDATE brief_paused_tasks SET state = 'pending'")
    const port = {
      getTask: async (id: string) => taskDetail(id, { hermesStatus: 'ready' }),
      taskAction,
    }
    const parking = createTaskHolds({
      port: port as unknown as HermesPort,
      db: h.score,
      ingest: h.ingest,
    })
    taskAction.mockResolvedValue({ hermesStatus: 'scheduled' })
    expect(await parking.apply({ kind: 'brief', id: 'b1' }, () => true)).toEqual([])
    expect(taskAction).toHaveBeenCalledTimes(1)
    expect(taskAction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't_current', action: 'schedule' }),
    )
  })

  test('another lineage’s hold does not keep this lineage’s task parked', async () => {
    const { holds, taskAction } = holdWorld()
    // t_current is held by two owners: the second hold belongs to the closed lineage.
    h.score.sqlite
      .prepare(
        "INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at, state, history_id) VALUES ('builder', 't_current', '2026-10-09T10:00:00.000Z', 'held', 'kh_old')",
      )
      .run()
    await holds.release({ kind: 'brief', id: 'b1' })
    expect(taskAction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't_current', action: 'unblock' }),
    )
  })
})

describe('Kanban denials', () => {
  const denial = (taskId: string, digest = 'a'.repeat(64)) => ({
    patternKey: 'rm',
    commandDigest: digest,
    taskId,
    runId: 7,
  })
  const producer = { profile: 'builder', id: 'p1', incarnation: 'i1' }
  const refs = (id: string) =>
    approvalView(h.score.sqlite, readApprovalRow(h.score.sqlite, id)!).refs

  test('the same task id in a new history is a new denial, and only a current one authorizes the task', () => {
    seedHistory(h.score.sqlite)
    h.score.tx((sqlite) => {
      projectTask(sqlite, taskDetail('t_a'))
      recordKanbanDenial(
        sqlite,
        denial('t_a'),
        producer,
        'rm -rf /',
        '2026-10-09T10:00:00.000Z',
        'ap-1',
      )
      // The very same denial again is deduplicated within its history.
      recordKanbanDenial(
        sqlite,
        denial('t_a'),
        producer,
        'rm -rf /',
        '2026-10-09T10:00:01.000Z',
        'ap-dup',
      )
    })
    expect(readApprovalRow(h.score.sqlite, 'ap-dup')).toBeUndefined()
    expect(refs('ap-1')).toEqual([{ kind: 'task', taskId: 't_a' }])
    // The history is replaced; the same task id and command come back.
    h.score.sqlite.exec(
      "UPDATE kanban_histories SET state = 'closed', closed_at = '2026-10-09T11:00:00.000Z'",
    )
    seedHistory(h.score.sqlite, { history: 'kh_new', state: 'active' })
    h.score.tx((sqlite) => {
      sqlite.prepare('UPDATE task_projections SET history_id = ?').run('kh_new')
      recordKanbanDenial(
        sqlite,
        denial('t_a'),
        producer,
        'rm -rf /',
        '2026-10-09T12:00:00.000Z',
        'ap-2',
      )
    })
    expect(readApprovalRow(h.score.sqlite, 'ap-2')).toBeDefined()
    // The old one points at another lineage: it never resolves to the new history's task.
    expect(refs('ap-1')).toEqual([])
    expect(refs('ap-2')).toEqual([{ kind: 'task', taskId: 't_a' }])
  })

  test('an unqualified denial never authorizes a task action; with attempts off it resolves as before', () => {
    seedHistory(h.score.sqlite)
    withFlag(false)
    h.score.tx((sqlite) => {
      projectTask(sqlite, taskDetail('t_a'))
      recordKanbanDenial(
        sqlite,
        denial('t_a'),
        producer,
        'rm',
        '2026-10-09T10:00:00.000Z',
        'ap-old',
      )
    })
    expect(refs('ap-old')).toEqual([{ kind: 'task', taskId: 't_a' }])
    withFlag(true)
    // Still unqualified (never assigned) and the projection carries no stamp either.
    expect(refs('ap-old')).toEqual([])
    h.score.sqlite.prepare("UPDATE task_projections SET history_id = 'kh_test'").run()
    h.score.sqlite.prepare("UPDATE approvals SET kanban_history_id = 'kh_test'").run()
    expect(refs('ap-old')).toEqual([{ kind: 'task', taskId: 't_a' }])
    // The task changed hands to a projection of another lineage: no longer unambiguous.
    h.score.sqlite.prepare("UPDATE task_projections SET history_id = 'kh_other'").run()
    expect(refs('ap-old')).toEqual([])
  })
})

import { describe, expect, test } from 'vitest'
import { listAttempts } from '../../../src/domain/kanban-attempts.ts'
import {
  h,
  installKanbanAttemptsProjectionHooks,
  started,
} from './kanban-attempts-projection-helpers.ts'

installKanbanAttemptsProjectionHooks()

describe('histories and watermarks', () => {
  test('event GC and normal maintenance keep one history without duplicates', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.tick(30)
    h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'built' })
    const coordinator = await started()
    const before = h.attempt(run)
    expect(before).toMatchObject({
      evidence: 'proven',
      classification_basis: 'claim_lock',
      status: 'completed',
    })

    // Hermes prunes every old event; the retained maxima fall, the allocation marks do not.
    h.board.gcEvents(1_000)
    h.board.task('t_b')
    const second = h.board.claim('t_b')
    await h.poll(coordinator, 3)

    expect(h.histories().filter((history) => history.state !== 'closed')).toHaveLength(1)
    expect(h.histories()).toHaveLength(1)
    expect(h.attempts()).toHaveLength(2)
    // Positive evidence was frozen when first seen: pruning the claim event changes nothing.
    expect(h.attempt(run)).toMatchObject({
      revision: before.revision,
      id: before.id,
      evidence: 'proven',
    })
    expect(h.attempt(second).status).toBe('running')
  })

  test('a task deleted upstream leaves a finite, non-extended open attempt in the same history', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a')
    const coordinator = await started()
    expect(h.attempt(run)).toMatchObject({ observing: 1, observation_ended_at: null })
    h.clock.ms += 3_600_000
    h.board.deleteTask('t_a')
    await h.poll(coordinator, 2)
    const gone = h.attempt(run)
    expect(h.histories()).toHaveLength(1)
    expect(h.histories()[0]).toMatchObject({ state: 'active' })
    expect(gone).toMatchObject({ status: 'running', ended_at: null, observing: 0 })
    expect(gone.deleted_upstream_at).not.toBeNull()
    expect(gone.observation_ended_at).toBe(gone.deleted_upstream_at)
    expect(gone.observation_gaps).toBe(1)
    // The interval stops at the boundary: a window after it no longer contains the attempt.
    const start = new Date(gone.started_at * 1000).toISOString()
    const after = new Date(Date.parse(gone.observation_ended_at!) + 3_600_000).toISOString()
    const later = new Date(Date.parse(after) + 3_600_000).toISOString()
    expect(
      listAttempts(h.score.sqlite, { since: start, until: after }).map((a) => a.attemptId),
    ).toEqual([run])
    expect(listAttempts(h.score.sqlite, { since: after, until: later })).toEqual([])
  })

  test('an in-place restore below the saved allocation mark opens a new history with a gap', async () => {
    h.board.task('t_a')
    const first = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    const early = h.board.snapshot()
    h.board.task('t_b')
    const open = h.board.claim('t_b', { lock: 'host:2' })
    const coordinator = await started()
    const oldHistory = h.histories()[0]!.id
    expect(h.attempt(open).observing).toBe(1)

    h.board.restore(early)
    await h.poll(coordinator, 4)

    const histories = h.histories()
    expect(histories).toHaveLength(2)
    expect(histories[0]).toMatchObject({ id: oldHistory, state: 'closed' })
    expect(histories[0]!.reason).toMatch(/allocation mark/)
    expect(histories[1]).toMatchObject({ state: 'active', baseline_done: 1 })
    // The attempt that only existed before the restore keeps its old history and a boundary, not an end time.
    expect(h.attempt(open, oldHistory)).toMatchObject({ ended_at: null, observing: 0 })
    expect(h.attempt(open, oldHistory).observation_ended_at).not.toBeNull()
    // The surviving attempt is copied into the new lineage and marked so aggregates count it once.
    const copy = h.attempt(first, histories[1]!.id)
    expect(copy.copied_from).toBe(h.attempt(first, oldHistory).id)
    expect(h.attempts().filter((a) => a.history_id === histories[1]!.id)).toHaveLength(1)
  })

  test('a restore that catches up past every saved mark with unchanged evidence is not detectable', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'v1' })
    const snapshot = h.board.snapshot()
    const coordinator = await started()
    h.board.setRun(run, { summary: 'v2' })
    await h.poll(coordinator, 2)
    expect(h.attempt(run).summary).toBe('v2')
    // Same marks, same frozen evidence, only content differs: documented as undetectable.
    h.board.restore(snapshot)
    await h.poll(coordinator, 2)
    expect(h.histories()).toHaveLength(1)
    expect(h.attempt(run)).toMatchObject({ summary: 'v1', revision: 3 })
  })

  test('closed -> open is a regression: the history closes and a new one opens', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    const coordinator = await started()
    h.board.setRun(run, { ended_at: null, outcome: null, status: 'running' })
    await h.poll(coordinator, 3)
    const histories = h.histories()
    expect(histories).toHaveLength(2)
    expect(histories[0]).toMatchObject({ state: 'closed' })
    expect(histories[0]!.reason).toMatch(/open again/)
    // The old history keeps the terminal fact it saw; the regression never rewrote it.
    expect(h.attempt(run, histories[0]!.id)).toMatchObject({ status: 'completed' })
    expect(h.attempt(run, histories[1]!.id)).toMatchObject({ status: 'running' })
  })

  test('a copy of the same database onto a new inode keeps the history', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    const identity = h.histories()[0]!.file_identity
    h.board.copyToNewInode()
    await h.poll(coordinator, 3)
    expect(h.histories()).toHaveLength(1)
    expect(h.histories()[0]!.file_identity).not.toBe(identity)
    expect(h.attempts()).toHaveLength(1)
    expect(h.attempt(run)).toMatchObject({ revision: 1, observing: 1 })
  })

  test('a new inode whose sampled attempts disagree is a contradiction', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    h.board.copyToNewInode()
    h.board.setRun(run, { started_at: 5 })
    await h.poll(coordinator, 3)
    expect(h.histories()).toHaveLength(2)
    expect(h.histories()[0]!.reason).toMatch(/start time/)
  })

  test('a new inode where no known attempt can be checked pauses the source', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    h.board.copyToNewInode()
    h.board.deleteTask('t_a')
    await h.poll(coordinator, 2)
    expect(run).toBe(1)
    expect(h.histories()).toHaveLength(1)
    expect(h.histories()[0]).toMatchObject({ state: 'paused' })
    expect(h.histories()[0]!.reason).toMatch(/no known attempt/)
  })

  test('a missing sequence row beside rows pauses the source, bounds open attempts, and resumes with the gap kept', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    h.board.setSequence('task_runs', null)
    await h.poll(coordinator, 2)
    expect(h.histories()[0]).toMatchObject({ state: 'paused' })
    expect(h.histories()[0]!.reason).toMatch(/no sqlite_sequence row/)
    const paused = h.attempt(run)
    expect(paused).toMatchObject({ observing: 0, ended_at: null, observation_gaps: 1 })
    expect(paused.observation_ended_at).not.toBeNull()
    expect(h.pages().at(-1)).toMatchObject({ outcome: 'paused' })

    h.board.setSequence('task_runs', 1)
    await h.poll(coordinator, 2)
    expect(h.histories()[0]).toMatchObject({ state: 'active', reason: null })
    const resumed = h.attempt(run)
    // Confirmed evidence returns: the boundary stays recorded, observation continues from the new read.
    expect(resumed).toMatchObject({
      observing: 1,
      observation_gaps: 1,
      observation_ended_at: paused.observation_ended_at,
    })
    expect(resumed.observation_resumed_at).not.toBeNull()
  })

  test('an empty table with no sequence row is valid and later rows are tracked', async () => {
    const coordinator = await started()
    expect(h.histories()[0]).toMatchObject({
      state: 'active',
      event_alloc_mark: 0,
      attempt_alloc_mark: 0,
    })
    h.board.task('t_a')
    const run = h.board.claim('t_a')
    await h.poll(coordinator, 2)
    expect(h.histories()[0]).toMatchObject({ event_alloc_mark: 2, attempt_alloc_mark: 1 })
    expect(h.attempt(run).status).toBe('running')
  })

  test("Hermes's legacy-shape migration (ids reassigned) opens a new history", async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    h.board.task('t_b')
    h.board.claim('t_b', { lock: 'host:2' })
    h.board.gcEvents(2)
    const coordinator = await started()
    // Rebuilt tables: ids are reassigned from 1 and the AUTOINCREMENT counters restart from the new maxima.
    h.board.db.exec(`
      DELETE FROM task_runs WHERE id = 1;
      UPDATE task_runs SET id = 1 WHERE id = 2;
      UPDATE sqlite_sequence SET seq = 1 WHERE name = 'task_runs';
      DELETE FROM task_events;
      UPDATE sqlite_sequence SET seq = 0 WHERE name = 'task_events';`)
    await h.poll(coordinator, 3)
    expect(h.histories()).toHaveLength(2)
    expect(h.histories()[0]).toMatchObject({ state: 'closed' })
    expect(h.histories()[1]).toMatchObject({ state: 'active' })
  })

  test('swapped ids with unchanged marks contradict through the immutable tuple', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    h.board.tick(5)
    h.board.task('t_b')
    h.board.claim('t_b', { lock: 'host:2' })
    const coordinator = await started()
    h.board.db.exec(
      'UPDATE task_runs SET id = 3 WHERE id = 1; UPDATE task_runs SET id = 1 WHERE id = 2; UPDATE task_runs SET id = 2 WHERE id = 3;',
    )
    await h.poll(coordinator, 3)
    expect(h.histories()).toHaveLength(2)
    expect(h.histories()[0]!.reason).toMatch(/another task|start time/)
  })

  test('a recreated board reusing attempt ids gives each id to exactly one history', async () => {
    h.board.task('t_a')
    const old = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    const coordinator = await started()
    const oldHistory = h.histories()[0]!.id
    // Recreated: every row is gone, ids start again and overtake the old marks with different content.
    h.board.db.exec(
      'DELETE FROM task_events; DELETE FROM task_runs; DELETE FROM tasks; UPDATE sqlite_sequence SET seq = 0;',
    )
    h.board.tick(100)
    for (const id of ['t_x', 't_y', 't_z']) {
      h.board.task(id)
      h.board.claim(id, { lock: `host:${id}` })
    }
    await h.poll(coordinator, 4)
    const histories = h.histories()
    expect(histories).toHaveLength(2)
    const reused = h.attempt(old, histories[1]!.id)
    expect(reused.task_id).not.toBe('t_a')
    expect(reused.copied_from).toBeNull()
    expect(h.attempt(old, oldHistory)).toMatchObject({ task_id: 't_a', status: 'completed' })
    expect(new Set(h.attempts().map((a) => a.id)).size).toBe(h.attempts().length)
  })
})

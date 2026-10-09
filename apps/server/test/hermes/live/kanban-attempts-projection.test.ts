import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { listAttempts } from '../../../src/domain/kanban-attempts.ts'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.close()
})

async function started(setup?: () => void) {
  setup?.()
  const coordinator = h.make()
  await h.poll(coordinator, 3)
  return coordinator
}

describe('histories and watermarks', () => {
  test('event GC and normal maintenance keep one history without duplicates', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.tick(30)
    h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'built' })
    const coordinator = await started()
    const before = h.attempt(run)
    expect(before).toMatchObject({ evidence: 'proven', classification_basis: 'claim_lock', status: 'completed' })

    // Hermes prunes every old event; the retained maxima fall, the allocation marks do not.
    h.board.gcEvents(1_000)
    h.board.task('t_b')
    const second = h.board.claim('t_b')
    await h.poll(coordinator, 3)

    expect(h.histories().filter((history) => history.state !== 'closed')).toHaveLength(1)
    expect(h.histories()).toHaveLength(1)
    expect(h.attempts()).toHaveLength(2)
    // Positive evidence was frozen when first seen: pruning the claim event changes nothing.
    expect(h.attempt(run)).toMatchObject({ revision: before.revision, id: before.id, evidence: 'proven' })
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
    expect(listAttempts(h.score.sqlite, { since: start, until: after }).map((a) => a.attemptId)).toEqual([run])
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
    expect(resumed).toMatchObject({ observing: 1, observation_gaps: 1, observation_ended_at: paused.observation_ended_at })
    expect(resumed.observation_resumed_at).not.toBeNull()
  })

  test('an empty table with no sequence row is valid and later rows are tracked', async () => {
    const coordinator = await started()
    expect(h.histories()[0]).toMatchObject({ state: 'active', event_alloc_mark: 0, attempt_alloc_mark: 0 })
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
    h.board.db.exec('UPDATE task_runs SET id = 3 WHERE id = 1; UPDATE task_runs SET id = 1 WHERE id = 2; UPDATE task_runs SET id = 2 WHERE id = 3;')
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
    h.board.db.exec('DELETE FROM task_events; DELETE FROM task_runs; DELETE FROM tasks; UPDATE sqlite_sequence SET seq = 0;')
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

describe('classification against every Hermes writer', () => {
  async function classified(setup: () => number[]) {
    const ids = setup()
    await started()
    return ids.map((id) => h.attempt(id))
  }

  test('claim: open and closed attempts are proven with the claim lock frozen', async () => {
    h.board.task('t_a')
    const open = h.board.claim('t_a', { lock: 'host:7' })
    const [attempt] = await classified(() => [open])
    expect(attempt).toMatchObject({ evidence: 'proven', classification_basis: 'claim_lock', role: 'implementer', claim_lock: 'host:7', profile: 'builder' })
    expect(attempt!.claim_event_id).not.toBeNull()
  })

  test('a reviewer claim carries the review source status', async () => {
    h.board.task('t_a', { status: 'review' })
    const run = h.board.claim('t_a', { profile: 'reviewer', sourceStatus: 'review' })
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ role: 'reviewer', claim_source_status: 'review', profile: 'reviewer' })
  })

  test.each([
    ['completed', 'done', 'completed', 'completed'],
    ['blocked', 'blocked', 'blocked', 'blocked'],
    ['review_requested', 'review', 'review_handoff', 'review_requested'],
    ['changes_requested', 'ready', 'changes_requested', 'changes_requested'],
    ['scheduled', 'scheduled', 'ended_unknown', 'scheduled'],
    ['crashed', 'crashed', 'failed', 'crashed'],
    ['timed_out', 'timed_out', 'failed', 'timed_out'],
    ['stale', 'failed', 'failed', 'stale'],
    ['gave_up', 'failed', 'failed', 'gave_up'],
    ['spawn_failed', 'failed', 'failed', 'spawn_failed'],
    ['reclaimed', 'reclaimed', 'ended_unknown', 'reclaimed'],
  ])('closing with %s maps to %s and keeps the claimed attempt proven', async (outcome, hermesStatus, status, reason) => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.tick(3)
    h.board.end('t_a', { outcome, status: hermesStatus })
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ status, closure_reason: reason, evidence: 'proven' })
  })

  test.each([
    ['blocked transition', 'blocked', 'blocked'],
    ['schedule', 'scheduled', 'scheduled'],
    ['request_review', 'review_requested', 'review_requested'],
    ['complete', 'completed', 'completed'],
    ['edit_task synthesis', 'completed', 'edited'],
  ])('%s on a never-claimed task is synthetic and never an attempt', async (_name, outcome, event) => {
    h.board.task('t_a')
    h.board.tick()
    h.board.synthesize('t_a', { outcome, event })
    await started()
    expect(h.attempts()).toEqual([])
  })

  test('a pruned claim event with a retained lock is proven', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    h.board.gcEvents(1_000)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ evidence: 'proven', classification_basis: 'claim_lock' })
  })

  test('dangling-run recovery: the claim event proves it after the lock is cleared', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.reclaimDangling(run)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ status: 'ended_unknown', closure_reason: 'reclaimed', evidence: 'proven', classification_basis: 'claim_event', claim_lock: null })
  })

  test('dangling-run recovery with the claim event pruned and nothing seen is partial', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.reclaimDangling(run)
    h.board.gcEvents(1_000)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ evidence: 'partial', classification_basis: 'closed_outcome_not_synthesized' })
  })

  test('a worker pid alone is positive evidence', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.spawn(run, 4242)
    h.board.clear(run, ['claim_lock'])
    h.board.end('t_a', { outcome: 'crashed' })
    h.board.gcEvents(1_000)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ evidence: 'proven', classification_basis: 'worker_pid', worker_pid: 4242, worker_started_at: 'boot|4242' })
  })

  test('legacy backfill: copied positive evidence is proven, none is partial', async () => {
    h.board.legacyRunningTask('t_a', { claimLock: 'host:legacy' })
    const withEvidence = h.board.legacyBackfill('t_a', { copyEvidence: true })
    h.board.legacyRunningTask('t_b')
    const without = h.board.legacyBackfill('t_b')
    const [proven, partial] = await classified(() => [withEvidence, without])
    expect(proven).toMatchObject({ evidence: 'proven', classification_basis: 'claim_lock' })
    expect(partial).toMatchObject({ evidence: 'partial', classification_basis: 'open_without_evidence', first_seen_open: 1 })
  })

  test('legacy backfill closed in the same second is partial, not synthetic', async () => {
    h.board.legacyRunningTask('t_a')
    const run = h.board.legacyBackfill('t_a')
    // block_task closes the backfilled run in the same second: byte-identical to a synthetic blocked row.
    h.board.end('t_a', { outcome: 'blocked', status: 'blocked', summary: 'why' })
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({ evidence: 'partial', status: 'blocked', first_seen_open: 0 })
    expect(attempt!.classification_basis).toBe('task_started_before_row')
  })

  test('a partial attempt seen open is never reclassified synthetic when it closes in the same second', async () => {
    h.board.legacyRunningTask('t_a')
    const run = h.board.legacyBackfill('t_a')
    const coordinator = await started()
    expect(h.attempt(run)).toMatchObject({ evidence: 'partial', first_seen_open: 1 })
    h.board.end('t_a', { outcome: 'blocked', status: 'blocked' })
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ evidence: 'partial', classification_basis: 'open_without_evidence', status: 'blocked', first_seen_open: 1 })
  })

  test('positive evidence appearing later promotes partial to proven, never the reverse', async () => {
    h.board.legacyRunningTask('t_a')
    const run = h.board.legacyBackfill('t_a')
    const coordinator = await started()
    expect(h.attempt(run).evidence).toBe('partial')
    h.board.spawn(run, 99)
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ evidence: 'proven', classification_basis: 'worker_pid' })
    h.board.clear(run, ['worker_pid'])
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ evidence: 'proven', worker_pid: 99 })
  })

  test('frozen evidence: a cleared lock is not a contradiction, a different lock is', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    h.board.clear(run, ['claim_lock'])
    await h.poll(coordinator, 2)
    expect(h.histories()).toHaveLength(1)
    expect(h.attempt(run).claim_lock).toBe('host:1')
    h.board.setRun(run, { claim_lock: 'host:2' })
    await h.poll(coordinator, 2)
    expect(h.histories()).toHaveLength(2)
    expect(h.histories()[0]!.reason).toMatch(/claim lock/)
  })
})

describe('writer transitions and revisions', () => {
  test('ended_unknown refines to a known terminal; a different known terminal is refused and counted', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'reclaimed', status: 'reclaimed' })
    const coordinator = await started()
    expect(h.attempt(run)).toMatchObject({ status: 'ended_unknown', revision: 1 })
    h.board.setRun(run, { outcome: 'completed', status: 'done' })
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ status: 'completed', closure_reason: 'completed', revision: 2 })
    h.board.setRun(run, { outcome: 'crashed', status: 'crashed' })
    await h.poll(coordinator, 2)
    expect(h.histories()).toHaveLength(1)
    expect(h.attempt(run)).toMatchObject({ status: 'completed', revision: 2, refused_updates: 1 })
  })

  test('same-terminal refresh takes newer content', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'one' })
    const coordinator = await started()
    h.board.setRun(run, { summary: 'two' })
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ summary: 'two', revision: 2 })
  })

  test('A -> B -> A over interleaved polls is three observed snapshots', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.setRun(run, { summary: 'A' })
    const coordinator = await started()
    const first = h.attempt(run)
    h.board.setRun(run, { summary: 'B' })
    await h.poll(coordinator, 1)
    h.board.setRun(run, { summary: 'A' })
    await h.poll(coordinator, 1)
    const third = h.attempt(run)
    expect(first.revision).toBe(1)
    expect(third.revision).toBe(3)
    expect(third.content_hash).toBe(first.content_hash)
    expect(third.summary).toBe('A')
  })

  test('a sweep picks up a change that has no event', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = await started()
    const cursor = h.histories()[0]!.event_cursor
    h.board.setRun(run, { summary: 'edited without an event' })
    await h.poll(coordinator, 1)
    expect(h.histories()[0]!.event_cursor).toBe(cursor)
    expect(h.attempt(run)).toMatchObject({ summary: 'edited without an event', revision: 2 })
  })

  test('a full pass finds rows that never had events', async () => {
    h.board.task('t_a')
    const coordinator = await started()
    const run = Number(
      h.board.db
        .prepare("INSERT INTO task_runs (task_id, profile, status, claim_lock, started_at) VALUES ('t_a', 'builder', 'running', 'host:1', ?)")
        .run(h.board.clock).lastInsertRowid,
    )
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ status: 'running', evidence: 'proven' })
  })

  test('a deleted closed row is recorded as deleted upstream without an observation boundary', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    const coordinator = await started()
    h.board.db.prepare('DELETE FROM task_runs WHERE id = ?').run(run)
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({ status: 'completed', observation_ended_at: null, observation_gaps: 0 })
    expect(h.attempt(run).deleted_upstream_at).not.toBeNull()
    expect(h.histories()).toHaveLength(1)
  })

  test('same-second reject, retry and approve keep their roles and order, with reassignment and a null role', async () => {
    h.board.task('t_a')
    const implement1 = h.board.claim('t_a', { lock: 'h:1', profile: 'builder' })
    h.board.end('t_a', { outcome: 'review_requested', status: 'review' })
    h.board.db.prepare("UPDATE tasks SET assignee = 'reviewer', status = 'review' WHERE id = 't_a'").run()
    const review1 = h.board.claim('t_a', { lock: 'h:2', profile: 'reviewer', sourceStatus: 'review' })
    h.board.end('t_a', { outcome: 'changes_requested', status: 'ready' })
    h.board.db.prepare("UPDATE tasks SET assignee = 'builder', status = 'ready' WHERE id = 't_a'").run()
    const implement2 = h.board.claim('t_a', { lock: 'h:3', profile: 'builder' })
    h.board.end('t_a', { outcome: 'review_requested', status: 'review' })
    const review2 = h.board.claim('t_a', { lock: 'h:4', profile: 'reviewer', sourceStatus: 'review' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    // The third attempt lost its claim event to pruning: its role is unknown, never the current assignee.
    h.board.db.prepare('DELETE FROM task_events WHERE run_id = ? AND kind = ?').run(implement2, 'claimed')
    await started()
    const listed = listAttempts(h.score.sqlite, { since: '2020-01-01T00:00:00.000Z', until: '2030-01-01T00:00:00.000Z', taskId: 't_a' })
    expect(listed.map((a) => [a.attemptId, a.role, a.status])).toEqual([
      [implement1, 'implementer', 'review_handoff'],
      [review1, 'reviewer', 'changes_requested'],
      [implement2, null, 'review_handoff'],
      [review2, 'reviewer', 'completed'],
    ])
    expect(new Set(listed.map((a) => a.startedAt)).size).toBe(1)
  })

  test('summaries and errors are redacted and bounded; the task snapshot is bounded', async () => {
    h.board.task('t_a', { title: `${'T'.repeat(800)} token=abcdefgh12345678` })
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', {
      outcome: 'crashed',
      summary: `Authorization: Bearer abcdef.ghijkl.mnopqr sk-abcdefghijklmnop ${'x'.repeat(20_000)}`,
      error: `password=hunter2hunter2 ${'e'.repeat(5_000)}`,
    })
    await started()
    const attempt = h.attempt(run)
    expect(Buffer.byteLength(attempt.summary!)).toBeLessThanOrEqual(8 * 1024)
    expect(Buffer.byteLength(attempt.error!)).toBeLessThanOrEqual(2 * 1024)
    expect(attempt.summary).not.toContain('abcdef.ghijkl')
    expect(attempt.summary).not.toContain('sk-abcdefghijklmnop')
    expect(attempt.error).not.toContain('hunter2')
    const snapshot = JSON.parse(attempt.task_snapshot!) as { title: string }
    expect(snapshot.title.length).toBeLessThanOrEqual(300)
    expect(snapshot.title).not.toContain('abcdefgh12345678')
    expect(attempt.task_snapshot!.length).toBeLessThanOrEqual(4096)
  })

  test('listAttempts filters by task and agent and orders by start, never by the opaque id', async () => {
    h.board.task('t_a')
    h.board.task('t_b', { assignee: 'reviewer' })
    const a = h.board.claim('t_a', { lock: 'h:1' })
    h.board.tick(10)
    const b = h.board.claim('t_b', { lock: 'h:2' })
    await started()
    const window = { since: '2020-01-01T00:00:00.000Z', until: '2030-01-01T00:00:00.000Z' }
    expect(listAttempts(h.score.sqlite, window).map((x) => x.attemptId)).toEqual([a, b])
    expect(listAttempts(h.score.sqlite, { ...window, agentId: 'reviewer' }).map((x) => x.attemptId)).toEqual([b])
    expect(listAttempts(h.score.sqlite, { ...window, taskId: 't_a' }).map((x) => x.attemptId)).toEqual([a])
    expect(listAttempts(h.score.sqlite, { ...window, agentId: 'nobody' })).toEqual([])
    expect(listAttempts(h.score.sqlite, window)[0]).toMatchObject({ historyState: 'active', taskSnapshot: { title: 'Task t_a', assignee: 'builder' } })
  })
})

import { describe, expect, test } from 'vitest'
import {
  h,
  installKanbanAttemptsProjectionHooks,
  started,
} from './kanban-attempts-projection-helpers.ts'

installKanbanAttemptsProjectionHooks()

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
    expect(attempt).toMatchObject({
      evidence: 'proven',
      classification_basis: 'claim_lock',
      role: 'implementer',
      claim_lock: 'host:7',
      profile: 'builder',
    })
    expect(attempt!.claim_event_id).not.toBeNull()
  })

  test('a reviewer claim carries the review source status', async () => {
    h.board.task('t_a', { status: 'review' })
    const run = h.board.claim('t_a', { profile: 'reviewer', sourceStatus: 'review' })
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({
      role: 'reviewer',
      claim_source_status: 'review',
      profile: 'reviewer',
    })
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
  ])(
    'closing with %s maps to %s and keeps the claimed attempt proven',
    async (outcome, hermesStatus, status, reason) => {
      h.board.task('t_a')
      const run = h.board.claim('t_a', { lock: 'host:1' })
      h.board.tick(3)
      h.board.end('t_a', { outcome, status: hermesStatus })
      const [attempt] = await classified(() => [run])
      expect(attempt).toMatchObject({ status, closure_reason: reason, evidence: 'proven' })
    },
  )

  test.each([
    ['blocked transition', 'blocked', 'blocked'],
    ['schedule', 'scheduled', 'scheduled'],
    ['request_review', 'review_requested', 'review_requested'],
    ['complete', 'completed', 'completed'],
    ['edit_task synthesis', 'completed', 'edited'],
  ])(
    '%s on a never-claimed task is synthetic and never an attempt',
    async (_name, outcome, event) => {
      h.board.task('t_a')
      h.board.tick()
      h.board.synthesize('t_a', { outcome, event })
      await started()
      expect(h.attempts()).toEqual([])
    },
  )

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
    expect(attempt).toMatchObject({
      status: 'ended_unknown',
      closure_reason: 'reclaimed',
      evidence: 'proven',
      classification_basis: 'claim_event',
      claim_lock: null,
    })
  })

  test('dangling-run recovery with the claim event pruned and nothing seen is partial', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.reclaimDangling(run)
    h.board.gcEvents(1_000)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({
      evidence: 'partial',
      classification_basis: 'closed_outcome_not_synthesized',
    })
  })

  test('a worker pid alone is positive evidence', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.spawn(run, 4242)
    h.board.clear(run, ['claim_lock'])
    h.board.end('t_a', { outcome: 'crashed' })
    h.board.gcEvents(1_000)
    const [attempt] = await classified(() => [run])
    expect(attempt).toMatchObject({
      evidence: 'proven',
      classification_basis: 'worker_pid',
      worker_pid: 4242,
      worker_started_at: 'boot|4242',
    })
  })

  test('legacy backfill: copied positive evidence is proven, none is partial', async () => {
    h.board.legacyRunningTask('t_a', { claimLock: 'host:legacy' })
    const withEvidence = h.board.legacyBackfill('t_a', { copyEvidence: true })
    h.board.legacyRunningTask('t_b')
    const without = h.board.legacyBackfill('t_b')
    const [proven, partial] = await classified(() => [withEvidence, without])
    expect(proven).toMatchObject({ evidence: 'proven', classification_basis: 'claim_lock' })
    expect(partial).toMatchObject({
      evidence: 'partial',
      classification_basis: 'open_without_evidence',
      first_seen_open: 1,
    })
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
    expect(h.attempt(run)).toMatchObject({
      evidence: 'partial',
      classification_basis: 'open_without_evidence',
      status: 'blocked',
      first_seen_open: 1,
    })
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

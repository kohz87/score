import { describe, expect, test } from 'vitest'
import { listAttempts } from '../../../src/domain/kanban-attempts.ts'
import {
  h,
  installKanbanAttemptsProjectionHooks,
  started,
} from './kanban-attempts-projection-helpers.ts'

installKanbanAttemptsProjectionHooks()

describe('writer transitions and revisions', () => {
  test('ended_unknown refines to a known terminal; a different known terminal is refused and counted', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'reclaimed', status: 'reclaimed' })
    const coordinator = await started()
    expect(h.attempt(run)).toMatchObject({ status: 'ended_unknown', revision: 1 })
    h.board.setRun(run, { outcome: 'completed', status: 'done' })
    await h.poll(coordinator, 2)
    expect(h.attempt(run)).toMatchObject({
      status: 'completed',
      closure_reason: 'completed',
      revision: 2,
    })
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
        .prepare(
          "INSERT INTO task_runs (task_id, profile, status, claim_lock, started_at) VALUES ('t_a', 'builder', 'running', 'host:1', ?)",
        )
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
    expect(h.attempt(run)).toMatchObject({
      status: 'completed',
      observation_ended_at: null,
      observation_gaps: 0,
    })
    expect(h.attempt(run).deleted_upstream_at).not.toBeNull()
    expect(h.histories()).toHaveLength(1)
  })

  test('same-second reject, retry and approve keep their roles and order, with reassignment and a null role', async () => {
    h.board.task('t_a')
    const implement1 = h.board.claim('t_a', { lock: 'h:1', profile: 'builder' })
    h.board.end('t_a', { outcome: 'review_requested', status: 'review' })
    h.board.db
      .prepare("UPDATE tasks SET assignee = 'reviewer', status = 'review' WHERE id = 't_a'")
      .run()
    const review1 = h.board.claim('t_a', {
      lock: 'h:2',
      profile: 'reviewer',
      sourceStatus: 'review',
    })
    h.board.end('t_a', { outcome: 'changes_requested', status: 'ready' })
    h.board.db
      .prepare("UPDATE tasks SET assignee = 'builder', status = 'ready' WHERE id = 't_a'")
      .run()
    const implement2 = h.board.claim('t_a', { lock: 'h:3', profile: 'builder' })
    h.board.end('t_a', { outcome: 'review_requested', status: 'review' })
    const review2 = h.board.claim('t_a', {
      lock: 'h:4',
      profile: 'reviewer',
      sourceStatus: 'review',
    })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    // The third attempt lost its claim event to pruning: its role is unknown, never the current assignee.
    h.board.db
      .prepare('DELETE FROM task_events WHERE run_id = ? AND kind = ?')
      .run(implement2, 'claimed')
    await started()
    const listed = listAttempts(h.score.sqlite, {
      since: '2020-01-01T00:00:00.000Z',
      until: '2030-01-01T00:00:00.000Z',
      taskId: 't_a',
    })
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
    expect(
      listAttempts(h.score.sqlite, { ...window, agentId: 'reviewer' }).map((x) => x.attemptId),
    ).toEqual([b])
    expect(
      listAttempts(h.score.sqlite, { ...window, taskId: 't_a' }).map((x) => x.attemptId),
    ).toEqual([a])
    expect(listAttempts(h.score.sqlite, { ...window, agentId: 'nobody' })).toEqual([])
    expect(listAttempts(h.score.sqlite, window)[0]).toMatchObject({
      historyState: 'active',
      taskSnapshot: { title: 'Task t_a', assignee: 'builder' },
    })
  })
})

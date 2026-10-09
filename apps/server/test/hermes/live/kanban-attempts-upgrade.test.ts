import { copyFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { migrate, openDatabase } from '../../../src/db/index.ts'
import { LiveTasks } from '../../../src/hermes/live/tasks.ts'
import { createHarness, MIGRATIONS, type Harness } from '../../fixtures/kanban/harness.ts'
import { createFixtureHome } from '../../fixtures/hermes/sqlite-fixture.ts'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.close()
})

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

function project(
  taskId: string,
  runIds: string[],
  activity: { at: string; agentId: string | null; text: string }[],
) {
  h.score.sqlite
    .prepare(
      'INSERT INTO task_projections (id, detail, revision, incarnation) VALUES (?, ?, 0, NULL)',
    )
    .run(taskId, JSON.stringify({ id: taskId, runIds, activity }))
}
function links() {
  return z
    .array(
      z.object({
        task_id: z.string(),
        legacy_id: z.string(),
        status: z.string(),
        attempt_key: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    )
    .parse(
      h.score.sqlite
        .prepare(
          'SELECT task_id, legacy_id, status, attempt_key, reason FROM kanban_upgrade_links ORDER BY task_id, CAST(legacy_id AS INTEGER)',
        )
        .all(),
    )
}

describe('legacy numeric run links', () => {
  test('only a claim activity with the frozen start second and claim profile maps; everything else is unresolved', async () => {
    h.board.task('t_a')
    h.board.task('t_b')
    const mapped = h.board.claim('t_a', { lock: 'h:1', profile: 'builder' })
    const startedAt = h.board.clock
    h.board.tick(10)
    h.board.end('t_a', { outcome: 'crashed' })
    const noProfile = h.board.claim('t_a', { lock: 'h:2', profile: 'builder' })
    const otherSecond = h.board.claim('t_b', { lock: 'h:3', profile: 'builder' })
    h.board.tick(60)
    const bare = h.board.claim('t_b', { lock: 'h:4', profile: 'builder' })
    const startedLater = h.board.clock
    project(
      't_a',
      [String(mapped), String(noProfile), '99', 'kr_not_legacy'],
      [
        { at: iso(startedAt), agentId: 'builder', text: 'claimed' },
        // Same second and text but no claim profile recorded (claim payloads usually lack one).
        { at: iso(startedAt + 10), agentId: null, text: 'claimed' },
        // Right profile, wrong text and wrong second: never proof.
        { at: iso(startedAt + 5), agentId: 'builder', text: 'comment' },
      ],
    )
    project(
      't_b',
      [String(otherSecond), String(bare)],
      [
        { at: iso(startedAt + 1), agentId: 'builder', text: 'claimed' },
        { at: iso(startedLater), agentId: 'reviewer', text: 'claimed' },
      ],
    )
    const coordinator = h.make()
    await h.poll(coordinator, 5)
    const rows = links()
    expect(rows.map((row) => `${row.task_id}:${row.legacy_id}:${row.status}`)).toEqual([
      `t_a:${mapped}:mapped`,
      `t_a:${noProfile}:unresolved`,
      't_a:99:unresolved',
      `t_b:${otherSecond}:unresolved`,
      `t_b:${bare}:unresolved`,
    ])
    expect(rows[0]!.attempt_key).toBe(h.attempt(mapped).id)
    expect(rows.find((row) => row.legacy_id === '99')!.reason).toBe('attempt_not_found')
    // Task id + numeric id alone (the same board, same history) never maps.
    expect(
      rows.filter((row) => row.status === 'unresolved').every((row) => row.attempt_key === null),
    ).toBe(true)
    expect(rows.find((row) => row.legacy_id === String(bare))!.reason).toBe(
      'no_affirmative_evidence',
    )
  })

  test('the inputs are snapshotted before reconciliation rewrites projections; links wait while Hermes is unavailable', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'h:1', profile: 'builder' })
    project('t_a', [String(run)], [{ at: iso(h.board.clock), agentId: 'builder', text: 'claimed' }])
    renameSync(h.board.path, `${h.board.path}.away`)
    const coordinator = h.make()
    await h.poll(coordinator, 2)
    expect(links()).toMatchObject([{ status: 'pending' }])
    // The 50-item activity window moves on and loses the claim: the snapshot still holds it.
    h.score.sqlite
      .prepare("UPDATE task_projections SET detail = ? WHERE id = 't_a'")
      .run(JSON.stringify({ id: 't_a', runIds: [String(run)], activity: [] }))
    renameSync(`${h.board.path}.away`, h.board.path)
    await h.poll(coordinator, 4)
    expect(links()).toMatchObject([{ status: 'mapped', attempt_key: h.attempt(run).id }])
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM kanban_upgrade_state').get()).toEqual({
      n: 1,
    })
  })

  test('resolution is resumable in batches and idempotent', async () => {
    h.board.task('t_a')
    project(
      't_a',
      Array.from({ length: 250 }, (_, index) => String(1000 + index)),
      [],
    )
    const coordinator = h.make()
    await h.poll(coordinator, 1)
    // One batch of 100 per poll.
    expect(links().filter((row) => row.status === 'pending')).toHaveLength(150)
    await coordinator.close()
    const restarted = h.make()
    await h.poll(restarted, 4)
    expect(links()).toHaveLength(250)
    expect(
      links().every((row) => row.status === 'unresolved' && row.reason === 'attempt_not_found'),
    ).toBe(true)
  })
})

describe('late relationship backfill', () => {
  function link(taskId: string, briefId = 'b1') {
    h.score.sqlite.exec('PRAGMA foreign_keys = OFF')
    h.score.sqlite
      .prepare(
        "INSERT OR IGNORE INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, 'room', 'Brief', '2026-10-09T10:00:00.000Z', 'you')",
      )
      .run(briefId)
    h.score.sqlite
      .prepare(
        "INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES (?, ?, 'child', '2026-10-09T10:00:01.000Z')",
      )
      .run(briefId, taskId)
  }
  const edges = () =>
    z
      .array(z.object({ id: z.string(), kind: z.string() }))
      .parse(h.score.sqlite.prepare('SELECT id, kind FROM brief_edges ORDER BY at, id').all())
  const associations = () =>
    z
      .array(z.object({ event_id: z.int() }))
      .parse(
        h.score.sqlite.prepare('SELECT event_id FROM kanban_associations ORDER BY event_id').all(),
      )
      .map((row) => row.event_id)

  test('review edges of a task linked after its events were consumed are backfilled; a crash mid-backfill resumes without duplicates', async () => {
    h.board.task('t_a')
    const first = h.board.event('t_a', 'review_requested')
    h.board.tick()
    const second = h.board.event('t_a', 'changes_requested')
    h.board.tick()
    const third = h.board.event('t_a', 'review_requested')
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    // The events were consumed while no brief owned the task.
    expect(edges()).toEqual([])
    link('t_a')
    await coordinator.close()
    let crashes = 0
    const crashing = h.make({
      associationHooks: {
        afterEdge() {
          if (++crashes === 1) throw new Error('crash mid-backfill')
        },
      },
    })
    await expect(h.poll(crashing, 1)).rejects.toThrow('crash mid-backfill')
    // The first edge and its progress committed together; no completion marker yet.
    expect(edges()).toHaveLength(1)
    expect(associations()).toEqual([first])

    await crashing.close()
    const resumed = h.make()
    await h.poll(resumed, 2)
    expect(edges().map((edge) => edge.kind)).toEqual(['review', 'sent_back', 'review'])
    expect(new Set(edges().map((edge) => edge.id)).size).toBe(3)
    expect(associations()).toEqual([0, first, second, third])
    // No task activity is re-emitted by the backfill; only brief updates.
    const types = z
      .array(z.object({ type: z.string() }))
      .parse(h.score.sqlite.prepare('SELECT type FROM events').all())
      .map((row) => row.type)
    expect(types).not.toContain('task.activity')
    expect(types).toContain('brief.upserted')
    // A later pass does nothing more.
    await h.poll(resumed, 2)
    expect(edges()).toHaveLength(3)
  })

  test('a second brief linked later gets its own edges from the same already-seen events', async () => {
    h.board.task('t_a')
    h.board.event('t_a', 'review_requested')
    link('t_a', 'b1')
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    expect(edges()).toHaveLength(1)
    link('t_a', 'b2')
    await h.poll(coordinator, 2)
    expect(edges()).toHaveLength(2)
    expect(
      new Set(
        h.score.sqlite
          .prepare('SELECT brief_id FROM brief_edges')
          .all()
          .map((row) => row.brief_id),
      ),
    ).toEqual(new Set(['b1', 'b2']))
  })
})

describe('populated upgrade and the flag', () => {
  test('the attempts migration adds tables only: runs, message_runs and the message/FTS triggers are untouched', () => {
    // Found by name: the migration's number moves when other tasks merge first.
    const attemptsMigration = readdirSync(MIGRATIONS).find((name) =>
      name.endsWith('_kanban_attempts.sql'),
    )!
    const home = createFixtureHome()
    try {
      const dir = join(home.home, 'migrations')
      mkdirSync(dir)
      for (const name of readdirSync(MIGRATIONS).filter((file) => file < attemptsMigration))
        copyFileSync(join(MIGRATIONS, name), join(dir, name))
      const db = openDatabase(join(home.home, 'populated.db'))
      migrate(db, dir)
      db.sqlite.exec('PRAGMA foreign_keys = OFF')
      db.sqlite.exec(`
        INSERT INTO runs (id, profile, origin, status, started_at, updated_at)
          VALUES ('run_1', 'builder', 'score', 'running', '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z'),
                 ('run_2', 'lead', 'gateway', 'running', '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z');
        INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
          VALUES ('m1', 'run_1', 'room', 'builder', 'm0', 0, 'turn_1', 'm0', 'hi', '[]', 'active', '2026-10-09T10:00:00.000Z');`)
      const shape = () =>
        db.sqlite
          .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_schema
              WHERE tbl_name IN ('runs', 'message_runs', 'tool_calls', 'messages') OR type = 'trigger' ORDER BY type, name`,
          )
          .all()
      const rows = () => ({
        runs: db.sqlite.prepare('SELECT * FROM runs ORDER BY id').all(),
        messageRuns: db.sqlite.prepare('SELECT * FROM message_runs').all(),
      })
      const before = { shape: shape(), rows: rows() }
      copyFileSync(join(MIGRATIONS, attemptsMigration), join(dir, attemptsMigration))
      migrate(db, dir)
      expect(shape()).toEqual(before.shape)
      expect(rows()).toEqual(before.rows)
      expect(
        db.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'kanban_%' AND type = 'table'",
          )
          .get(),
      ).toEqual({ n: 8 })
      db.close()
    } finally {
      home.close()
    }
  })

  test('SCORE_KANBAN_ATTEMPTS: off by default, on builds the projection next to the task projection', async () => {
    const off = new LiveTasks(h.score, h.ingest, h.home)
    expect(off.attempts).toBeUndefined()
    await off.close()
    const previous = process.env.SCORE_KANBAN_ATTEMPTS
    process.env.SCORE_KANBAN_ATTEMPTS = '1'
    try {
      const fromEnv = new LiveTasks(h.score, h.ingest, h.home)
      expect(fromEnv.attempts).toBeDefined()
      await fromEnv.close()
    } finally {
      if (previous === undefined) delete process.env.SCORE_KANBAN_ATTEMPTS
      else process.env.SCORE_KANBAN_ATTEMPTS = previous
    }
  })

  test('with the flag on LiveTasks.poll projects tasks and attempts side by side; off, no attempt table is touched', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    const off = new LiveTasks(h.score, h.ingest, h.home, { kanbanAttempts: false })
    await off.poll()
    await off.close()
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM kanban_attempts').get()).toEqual({
      n: 0,
    })
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM kanban_histories').get()).toEqual({
      n: 0,
    })
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM task_projections').get()).toEqual({
      n: 1,
    })

    const on = new LiveTasks(h.score, h.ingest, h.home, { kanbanAttempts: true })
    await on.poll()
    await on.poll()
    await on.close()
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM kanban_attempts').get()).toEqual({
      n: 1,
    })
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM task_projections').get()).toEqual({
      n: 1,
    })
  })
})

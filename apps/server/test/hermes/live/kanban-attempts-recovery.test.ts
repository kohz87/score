import { renameSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { pruneKanbanAttempts } from '../../../src/hermes/live/kanban-attempts/retention.ts'
import { plannedQueries, readCapture } from '../../../src/hermes/live/kanban-attempts/reader.ts'
import { applyCapture } from '../../../src/hermes/live/kanban-attempts/writer.ts'
import { closeReadOnly, openReadOnly } from '../../../src/hermes/live/sqlite.ts'
import type { Capture } from '../../../src/hermes/live/kanban-attempts/types.ts'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.close()
})

function seed(count: number, options: { events?: boolean } = {}) {
  const insertTask = h.board.db.prepare(
    "INSERT INTO tasks (id, title, assignee, status, created_at) VALUES (?, ?, 'builder', 'done', ?)",
  )
  const insertRun = h.board.db.prepare(
    `INSERT INTO task_runs (task_id, profile, status, claim_lock, started_at, ended_at, outcome)
     VALUES (?, 'builder', 'done', ?, ?, ?, 'completed')`,
  )
  h.board.db.exec('BEGIN')
  for (let index = 1; index <= count; index++) {
    insertTask.run(`t_${index}`, `Task ${index}`, h.board.clock)
    insertRun.run(`t_${index}`, `host:${index}`, h.board.clock + index, h.board.clock + index + 1)
  }
  h.board.db.exec('COMMIT')
  if (options.events) h.board.event('t_1', 'created')
}

describe('reader', () => {
  test('every source query is a primary-key range, a known-id list or the task_id index (no table scans)', () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    h.board.end('t_a', { outcome: 'completed', status: 'done' })
    expect(run).toBe(1)
    for (const query of plannedQueries()) {
      const plan = z
        .array(z.object({ detail: z.string() }))
        .parse(h.board.db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params))
        .map((row) => row.detail)
      const scans = plan.filter((detail) => /^SCAN (task_runs|task_events)\b/.test(detail))
      expect({ name: query.name, scans }).toEqual({ name: query.name, scans: [] })
    }
  })

  test('pages are bounded at 200 attempts and 500 events', () => {
    seed(450)
    for (let index = 0; index < 700; index++) h.board.event('t_1', 'commented')
    const reader = openReadOnly(h.board.path)
    try {
      const page = readCapture(reader, { kind: 'baseline', historyId: 'h', sourceId: 's', fileIdentity: 'x' })
      expect(page.attempts).toHaveLength(200)
      expect(page.range).toEqual({ from: 0, to: 200 })
      const last = readCapture(reader, { kind: 'baseline', historyId: 'h', sourceId: 's', fileIdentity: 'x', afterAttemptId: 400 })
      expect(last.attempts).toHaveLength(50)
      expect(last.range).toEqual({ from: 400, to: null })
      const tail = readCapture(reader, { kind: 'tail', historyId: 'h', sourceId: 's', fileIdentity: 'x', afterEventId: 0 })
      expect(tail.events).toHaveLength(500)
      expect(tail.eventScanned).toBe(500)
    } finally {
      closeReadOnly(reader)
    }
  })

  test('one capture is one read transaction: rows changing between its queries are not seen', () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const reader = openReadOnly(h.board.path)
    try {
      let wrote = false
      const capture = readCapture(
        reader,
        { kind: 'tail', historyId: 'h', sourceId: 's', fileIdentity: 'x', afterEventId: 0 },
        {
          between(stage) {
            if (stage !== 'marks' || wrote) return
            wrote = true
            // Hermes keeps writing while the capture is open.
            h.board.task('t_b')
            h.board.claim('t_b', { lock: 'host:2' })
            h.board.setRun(run, { summary: 'changed mid-capture' })
            h.board.deleteTask('t_a')
          },
        },
      )
      expect(wrote).toBe(true)
      // Marks, events, attempt rows, evidence and task rows all come from the snapshot taken before the writes.
      expect(capture.marks).toMatchObject({ eventSeq: 2, runSeq: 1, eventMax: 2, runMax: 1 })
      expect(capture.events.map((event) => event.id)).toEqual([1, 2])
      expect(capture.attempts.map((attempt) => [attempt.id, attempt.summary])).toEqual([[1, null]])
      expect(capture.tasks.map((task) => task.id)).toEqual(['t_a'])
      expect(capture.evidenceEvents.map((event) => event.kind)).toEqual(['created', 'claimed'])
      const next = readCapture(reader, { kind: 'tail', historyId: 'h', sourceId: 's', fileIdentity: 'x', afterEventId: 2 })
      expect(next.marks).toMatchObject({ eventSeq: 4 })
      expect(next.attempts.map((attempt) => attempt.id)).toEqual([2])
    } finally {
      closeReadOnly(reader)
    }
  })

  test('malformed rows are counted, skipped and never stall the scan position', () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    h.board.db.exec("INSERT INTO task_runs (task_id, status, started_at) VALUES ('t_a', 'running', 5)")
    h.board.db.exec('DROP INDEX IF EXISTS idx_runs_task')
    h.board.db.exec("UPDATE task_runs SET started_at = 'not a number' WHERE id = 2")
    const reader = openReadOnly(h.board.path)
    try {
      const capture = readCapture(reader, { kind: 'baseline', historyId: 'h', sourceId: 's', fileIdentity: 'x' })
      expect(capture.attempts.map((attempt) => attempt.id)).toEqual([1])
      expect(capture.malformed).toBe(1)
    } finally {
      closeReadOnly(reader)
    }
  })
})

describe('captures, pages and restarts', () => {
  test('a multi-page baseline resumes after a restart and a replaced source mid-baseline starts over', async () => {
    seed(450, { events: true })
    const first = h.make({ maxBaselinePages: 1 })
    await h.poll(first, 1)
    expect(h.histories()[0]).toMatchObject({ baseline_cursor: 200, baseline_done: 0 })
    expect(h.attempts()).toHaveLength(200)
    await first.close()
    // Process restart: a new coordinator continues from the durable cursor.
    const second = h.make({ maxBaselinePages: 1 })
    await h.poll(second, 1)
    expect(h.histories()[0]).toMatchObject({ baseline_cursor: 400, baseline_done: 0 })
    // The source is replaced under the baseline: lower marks.
    h.board.db.exec('DELETE FROM task_runs WHERE id > 100; UPDATE sqlite_sequence SET seq = 100 WHERE name = \'task_runs\';')
    await h.poll(second, 2)
    const histories = h.histories()
    expect(histories).toHaveLength(2)
    expect(histories[0]).toMatchObject({ state: 'closed', baseline_done: 0 })
    // The new lineage baselines from the start (100 rows fit one page).
    expect(histories[1]).toMatchObject({ state: 'active', baseline_done: 1 })
    expect(h.attempts().filter((a) => a.history_id === h.histories()[1]!.id)).toHaveLength(100)
  })

  test('eventless baseline pages in one batch get distinct capture ids; a restart never repeats them', async () => {
    seed(450)
    const first = h.make({ maxBaselinePages: 3 })
    await h.poll(first, 1)
    await h.poll(first, 1)
    const baseline = h.pages().filter((page) => page.kind === 'baseline')
    expect(baseline).toHaveLength(3)
    expect(h.histories()[0]).toMatchObject({ baseline_done: 1 })
    expect(h.attempts()).toHaveLength(450)
    expect(new Set(baseline.map((page) => page.capture_id)).size).toBe(3)
    expect(baseline.every((page) => page.outcome === 'applied')).toBe(true)
    // Restart: the same first tick again, fresh ids, and the full pass re-reads without duplicating rows.
    await first.close()
    const second = h.make()
    await h.poll(second, 3)
    const ids = h.pages().map((page) => page.capture_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(h.attempts()).toHaveLength(450)
    expect(h.attempts().every((attempt) => attempt.revision === 1)).toBe(true)
    const cycle = h.pages().filter((page) => page.kind === 'fullpass')
    expect(cycle.length).toBeGreaterThanOrEqual(2)
  })

  test('baseline and sweep observations carry no event-retirement floor', async () => {
    seed(3)
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    const keys = z
      .array(z.object({ identity: z.string(), scope: z.string().nullable(), position: z.int().nullable() }))
      .parse(h.score.sqlite.prepare("SELECT identity, scope, position FROM ingest_keys WHERE identity LIKE 'kanban:%'").all())
    const events = keys.filter((key) => /^kanban:(baseline|sweep|fullpass):/.test(key.identity))
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((key) => key.scope === null && key.position === null)).toBe(true)
  })

  test('a failure inside the writer transaction loses nothing and replays the same capture id', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    let crash = false
    const committed: string[] = []
    const coordinator = h.make({
      faults: {
        afterRows() {
          if (crash) throw new Error('crash inside the writer transaction')
        },
      },
      afterCommit: (capture) => committed.push(capture.captureId),
    })
    await h.poll(coordinator, 2)
    const pagesBefore = h.pages().length
    const cursorBefore = h.histories()[0]!.event_cursor

    h.board.tick()
    h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'finished' })
    crash = true
    await expect(h.poll(coordinator, 1)).rejects.toThrow('crash inside')
    // Rolled back: no page, no cursor movement, the attempt still open.
    expect(h.pages()).toHaveLength(pagesBefore)
    expect(h.histories()[0]!.event_cursor).toBe(cursorBefore)
    expect(h.attempt(run).status).toBe('running')

    crash = false
    await h.poll(coordinator, 1)
    expect(h.attempt(run)).toMatchObject({ status: 'completed', summary: 'finished', revision: 2 })
    expect(h.histories()[0]!.event_cursor).toBeGreaterThan(cursorBefore)
    // The retry reused the captured page's id: exactly one page row exists for it.
    const ids = h.pages().map((page) => page.capture_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a crash after commit replays without duplicates or extra revisions', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    let crashAfterCommit = true
    const sink = {
      async submit(obs: Parameters<typeof h.ingest.submit>[0]) {
        const result = await h.ingest.submit(obs)
        if (crashAfterCommit && obs.identity.startsWith('kanban:baseline:')) {
          crashAfterCommit = false
          throw new Error('crash after commit')
        }
        return result
      },
    }
    const coordinator = h.make({ sink })
    await expect(h.poll(coordinator, 1)).rejects.toThrow()
    // The very capture is still pending in memory and is resubmitted: the ingest identity dedupes it.
    await h.poll(coordinator, 3)
    expect(h.attempts()).toHaveLength(1)
    expect(h.attempt(run).revision).toBe(1)
    // A restarted process has no pending capture; it reads again under a new id and changes nothing.
    await coordinator.close()
    const restarted = h.make()
    await h.poll(restarted, 3)
    expect(h.attempts()).toHaveLength(1)
    expect(h.attempt(run).revision).toBe(1)
    const ids = h.pages().map((page) => page.capture_id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a captured page for a history that was replaced meanwhile is recorded stale and applies nothing', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    const history = h.histories()[0]!
    const reader = openReadOnly(h.board.path)
    let capture: Capture
    try {
      capture = readCapture(reader, { kind: 'baseline', historyId: history.id, sourceId: 'ks', fileIdentity: history.file_identity! })
    } finally {
      closeReadOnly(reader)
    }
    h.score.sqlite.prepare("UPDATE kanban_histories SET state = 'closed', closed_at = 'x' WHERE id = ?").run(history.id)
    const result = h.score.tx((sqlite) => applyCapture(sqlite, capture, '2030-01-01T00:00:00.000Z'))
    expect(result.outcome).toBe('stale')
    expect(h.pages().at(-1)).toMatchObject({ capture_id: capture.captureId, outcome: 'stale' })
    // Applying the same capture id again is a no-op.
    expect(h.score.tx((sqlite) => applyCapture(sqlite, capture, '2030-01-01T00:00:00.000Z')).outcome).toBe('applied')
  })

  test('an unreadable source ends observation of open attempts after repeated failures and resumes when readable', async () => {
    h.board.task('t_a')
    const run = h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make({ unreadableAfter: 2 })
    await h.poll(coordinator, 3)
    expect(h.attempt(run).observing).toBe(1)
    renameSync(h.board.path, `${h.board.path}.away`)
    await h.poll(coordinator, 1)
    // One failed poll is a hiccup: the source stays active.
    expect(h.histories()[0]).toMatchObject({ state: 'active' })
    await h.poll(coordinator, 1)
    expect(h.histories()[0]).toMatchObject({ state: 'paused', reason: 'database missing' })
    const bounded = h.attempt(run)
    expect(bounded).toMatchObject({ observing: 0, ended_at: null })
    expect(bounded.observation_ended_at).not.toBeNull()
    renameSync(`${h.board.path}.away`, h.board.path)
    await h.poll(coordinator, 2)
    expect(h.histories()[0]).toMatchObject({ state: 'active', reason: null })
    expect(h.attempt(run)).toMatchObject({ observing: 1, observation_ended_at: bounded.observation_ended_at })
  })

  test('hourly retention keeps pages 7 days, never the latest page of a live history, and drops closed histories seen events', async () => {
    h.board.task('t_a')
    h.board.claim('t_a', { lock: 'host:1' })
    const coordinator = h.make()
    await h.poll(coordinator, 3)
    h.board.tick()
    h.board.task('t_b')
    await h.poll(coordinator, 2)
    const history = h.histories()[0]!
    const day = 24 * 3600 * 1000
    h.score.sqlite
      .prepare("UPDATE kanban_pages SET captured_at = ? WHERE kind = 'tail'")
      .run(new Date(h.clock.ms - 8 * day).toISOString())
    h.score.sqlite.prepare("UPDATE kanban_pages SET captured_at = ? WHERE kind = 'sweep'").run(new Date(h.clock.ms - 9 * day).toISOString())
    const before = h.pages()
    expect(before.some((page) => page.kind === 'tail')).toBe(true)
    const result = pruneKanbanAttempts(h.score, h.clock.ms)
    expect(result.pages).toBeGreaterThan(0)
    const after = h.pages()
    // Old pages are gone except the newest page of each kind of the live history.
    expect(after.filter((page) => page.kind === 'tail')).toHaveLength(1)
    expect(after.filter((page) => page.kind === 'sweep')).toHaveLength(1)
    expect(after.filter((page) => page.kind === 'baseline').length).toBe(before.filter((page) => page.kind === 'baseline').length)
    h.score.sqlite.prepare("UPDATE kanban_histories SET state = 'closed', closed_at = 'x' WHERE id = ?").run(history.id)
    pruneKanbanAttempts(h.score, h.clock.ms)
    expect(h.score.sqlite.prepare('SELECT COUNT(*) AS n FROM kanban_seen_events').get()).toEqual({ n: 0 })
  })
})

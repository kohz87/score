import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { actionable, readApprovalRow } from '../src/domain/approval-store.ts'
import { CodingJournal } from '../src/domain/orchestration/coding-journal.ts'
import { codingProjection } from '../src/domain/orchestration/coding-checkpoint.ts'
import { ExecutionJournal, JOURNAL_FILE } from '../src/domain/orchestration/journal.ts'
import {
  completeJournalHistory,
  resetDatabaseHistory,
  resetJournalHistory,
} from '../src/history-reset.ts'
import { again, fenceOf, fullReset, root } from './execution-freeze-helpers.ts'

test('reset-history unfreezes for good: it retires every unfinished record, archives the old journal and never re-sends', () => {
  const dir = join(root, 'reset')
  mkdirSync(dir)
  const { journal, database } = fenceOf(dir, 'ns-id')
  const coding = new CodingJournal(journal)
  const project = codingProjection(database)
  coding.requestLaunch({ launchId: 'L1', runId: 'r1', turnId: 't1', generation: 1 }, project)
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'released.json'), '{}')
  database.sqlite.exec('PRAGMA foreign_keys = OFF')
  database.sqlite.exec(`
    INSERT INTO command_intents (id, kind, idempotency_key, payload, state, stop_state, created_at, updated_at)
      VALUES ('i1', 'start_run', 'hermes-turn', '{}', 'accepted', 'pending', 'x', 'x'),
             ('i2', 'start_coding_run', 't2', '{}', 'pending', NULL, 'x', 'x');
    INSERT INTO coding_processes (run_id, pid, pgid, created_at) VALUES ('r9', 4242, 4242, 'x');
    INSERT INTO coding_process_members (run_id, pid, start_time, seen_at) VALUES ('r9', 4243, '1', 'x');
    INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
      gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
      acknowledgement, preflight, reserve_bytes, created_at, updated_at)
      VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, 'x', 'x');
    INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
      state, input, run_id, stop_requested_at, created_at, updated_at)
      VALUES ('att1', 'o1', 'lead', 1, 'lead', 'i', 's', 'turn-att', 'm', 'running', '', 'live-run', 'x', 'x', 'x');`)
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  const frozen = again(dir, 'ns-id', database)
  expect(frozen.startupCheck().reasons).toContain('journal_missing')

  const archived = resetJournalHistory({
    journalDir: dir,
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
  })
  const done = resetDatabaseHistory(
    database.sqlite,
    '2026-10-13T00:00:00.000Z',
    archived.generation,
  )
  completeJournalHistory({
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
    generation: archived.generation,
  })
  expect(done).toMatchObject({ attempts: 1, launches: 1 })
  const rows = (sql: string) => database.sqlite.prepare(sql).all()
  expect(rows('SELECT id, state, stop_state FROM command_intents ORDER BY id')).toEqual([
    { id: 'i1', state: 'failed', stop_state: 'done' }, // a handle to a run Score never saw is invalidated
    { id: 'i2', state: 'failed', stop_state: null },
  ])
  expect(rows('SELECT run_id FROM coding_processes')).toEqual([])
  expect(rows('SELECT run_id FROM coding_process_members')).toEqual([])
  expect(
    rows(
      'SELECT state, unknown_reason, stop_acknowledged_at IS NOT NULL AS acked FROM orc_attempts',
    ),
  ).toEqual([{ state: 'unknown', unknown_reason: 'history_reset', acked: 1 }])
  // The launch's turn is retired and the launch itself stays an unsendable witness.
  expect(rows('SELECT launch_id, unsendable, held, journal_n FROM coding_launches')).toEqual([
    { launch_id: 'L1', unsendable: 1, held: 0, journal_n: 0 },
  ])
  expect(rows('SELECT frozen_reason, fenced FROM orc_global')).toEqual([
    { frozen_reason: null, fenced: 0 },
  ])

  // The new journal starts with the permanent history-reset record; the old files are archived beside it.
  const fresh = new ExecutionJournal(join(dir, 'ns'), 'ns-id').readOwn()
  if (!fresh.ok) throw new Error(fresh.reason)
  expect(fresh.entries.map((e) => e.kind)).toEqual(['history-reset', 'history-reset-complete'])
  expect(existsSync(join(dir, 'ns', archived.archive))).toBe(true)
  expect(existsSync(join(dir, 'ns', 'launches', 'L1'))).toBe(false)
  expect(readdirSync(join(dir, 'ns', archived.archive, 'launches'))).toEqual(['L1'])
  // Nothing is frozen on the next start, and nothing fences either.
  const next = again(dir, 'ns-id', database)
  expect(next.startupCheck()).toEqual({ fenced: false, reasons: [] })
  expect(next.executionFrozen()).toBeNull()
  database.close()
})

test('reset-history on a damaged journal still archives it', () => {
  const dir = join(root, 'reset2')
  mkdirSync(join(dir, 'ns'), { recursive: true })
  writeFileSync(join(dir, 'ns', JOURNAL_FILE), 'garbage\n')
  const result = resetJournalHistory({
    journalDir: dir,
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
  })
  expect(result.archived).toBe(1) // lines, damaged or not
  expect(readFileSync(join(dir, 'ns', result.archive, JOURNAL_FILE), 'utf8')).toBe('garbage\n')
  const fresh = new ExecutionJournal(join(dir, 'ns'), 'ns-id').readOwn()
  expect(fresh.ok && fresh.entries.map((e) => e.kind)).toEqual(['history-reset'])
})

test('FU #5: a database backup from before the reset is frozen, and so is a reset that was never completed', () => {
  const dir = join(root, 'generation')
  mkdirSync(dir)
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  database.sqlite.exec('PRAGMA foreign_keys = OFF')
  database.sqlite.exec(
    `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('i1', 'start_coding_run', 'turn-old', '{}', 'pending', 'x', 'x')`,
  )
  // A reset whose database half happened but whose completion record was never written.
  const journal = resetJournalHistory({
    journalDir: dir,
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
  })
  expect(again(dir, 'ns-id', database).executionFrozen()).toMatch(/not finished/)
  resetDatabaseHistory(database.sqlite, new Date().toISOString(), journal.generation)
  expect(again(dir, 'ns-id', database).executionFrozen()).toMatch(/not finished/)
  completeJournalHistory({
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
    generation: journal.generation,
  })
  expect(again(dir, 'ns-id', database).startupCheck()).toEqual({ fenced: false, reasons: [] })
  // The probe of re-review 5: the database from before the reset comes back (pending intent, no generation).
  database.sqlite.exec(
    "UPDATE orc_global SET history_generation = NULL WHERE id = 1; UPDATE command_intents SET state = 'pending'",
  )
  const restored = again(dir, 'ns-id', database)
  expect(restored.startupCheck().reasons).toContain('history_generation_mismatch')
  expect(restored.executionFrozen()).toMatch(/backup from before/)
  // ... and only a new reset leaves it.
  fullReset(dir, database)
  expect(again(dir, 'ns-id', database).executionFrozen()).toBeNull()
  database.close()
})

// ---- FT #2 (re-review 6): adoption of the reset generation needs a database with no execution state ----------------------

const STALE_STATE: Record<string, string> = {
  'a queued chat reply': `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
    VALUES ('m1', 'r1', 'builder', 'm0', 0, 'turn-1', 'm0', 'go', '[]', 'pending', 'x')`,
  'a running run': `INSERT INTO runs (id, profile, origin, status, started_at, updated_at)
    VALUES ('run-1', 'builder', 'score', 'running', 'x', 'x')`,
  'an approval delivery': `INSERT INTO approval_deliveries (id, approval_id, choice, route, state, created_at, updated_at)
    VALUES ('d1', 'ap1', 'once', 'bridge', 'intent', 'x', 'x')`,
}

for (const [label, sql] of Object.entries(STALE_STATE)) {
  test(`FT #2: a pre-reset backup that still holds ${label} is frozen, not adopted`, () => {
    const dir = join(root, 'adopt-' + label.replaceAll(' ', '-'))
    mkdirSync(dir)
    const { database } = fenceOf(dir, 'ns-id')
    database.sqlite.exec('PRAGMA foreign_keys = OFF')
    database.sqlite.exec(sql)
    // The reset finished against the journal (another database was retired); this one is an older copy.
    const journal = resetJournalHistory({
      journalDir: dir,
      namespaceDir: join(dir, 'ns'),
      installationId: 'ns-id',
    })
    completeJournalHistory({
      namespaceDir: join(dir, 'ns'),
      installationId: 'ns-id',
      generation: journal.generation,
    })
    const restored = again(dir, 'ns-id', database)
    expect(restored.startupCheck().reasons).toContain('history_generation_mismatch')
    expect(restored.executionFrozen()).toMatch(/backup from before/)
    database.close()
  })
}

test('FT #2: a database with no execution state at all still adopts the generation', () => {
  const dir = join(root, 'adopt-fresh')
  mkdirSync(dir)
  const { database } = fenceOf(dir, 'ns-id')
  const journal = resetJournalHistory({
    journalDir: dir,
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
  })
  completeJournalHistory({
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
    generation: journal.generation,
  })
  const next = again(dir, 'ns-id', database)
  expect(next.startupCheck()).toEqual({ fenced: false, reasons: [] })
  expect(next.executionFrozen()).toBeNull()
  database.close()
})

test('FT #4: reset retires active replies, live run rows, their pending approvals and every unfinished approval delivery', () => {
  const dir = join(root, 'retire-all')
  mkdirSync(dir)
  const { database } = fenceOf(dir, 'ns-id')
  const sqlite = database.sqlite
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('run-1', 'builder', 'score', 'running', 'x', 'x');
    INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
      VALUES ('m1', 'run-1', 'r1', 'builder', 'm0', 0, 'turn-1', 'm0', 'go', '[]', 'active', 'x');
    INSERT INTO approval_deliveries (id, approval_id, choice, route, state, lease_id, lease_until, created_at, updated_at)
      VALUES ('d1', 'ap1', 'once', 'bridge', 'delivering', 'l1', 9999999999999, 'x', 'x'),
             ('d2', 'ap2', 'once', 'bridge', 'intent', NULL, NULL, 'x', 'x'),
             ('d3', 'ap3', 'once', 'port', 'applied', NULL, NULL, 'x', 'x');`)
  resetDatabaseHistory(sqlite, new Date().toISOString())
  expect(sqlite.prepare('SELECT state FROM message_runs').all()).toEqual([{ state: 'failed' }])
  expect(sqlite.prepare('SELECT status FROM runs').all()).toEqual([{ status: 'interrupted' }])
  expect(sqlite.prepare('SELECT id, state FROM approval_deliveries ORDER BY id').all()).toEqual([
    { id: 'd1', state: 'failed' },
    { id: 'd2', state: 'failed' },
    { id: 'd3', state: 'applied' },
  ])
  database.close()
})

test('verification #2: reset withdraws every unfinished approval, a gateway one without a run too, so it cannot be answered again', () => {
  const dir = join(root, 'retire-approvals')
  mkdirSync(dir)
  const { database } = fenceOf(dir, 'ns-id')
  const sqlite = database.sqlite
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    INSERT INTO approvals (id, origin, stage, target_kind, request_id, profile, session_key, surface, command, description,
      pattern_keys, choices, phase, status, created_at, updated_at)
    VALUES ('gw', 'gateway', 'human', 'gateway_request', 'req-1', 'builder', 'old-session', 'cli', 'rm', 'd', '[]', '["once"]',
      'human_pending', 'pending', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
           ('done', 'gateway', 'human', 'gateway_request', 'req-2', 'builder', 'old-session', 'cli', 'rm', 'd', '[]', '["once"]',
      'executed', 'approved', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');
    INSERT INTO approval_deliveries (id, approval_id, choice, route, state, lease_id, lease_until, created_at, updated_at)
      VALUES ('d1', 'gw', 'once', 'bridge', 'delivering', 'l1', 9999999999999, '2026-10-13T00:00:00.000Z',
        '2026-10-13T00:00:00.000Z');`)
  resetDatabaseHistory(sqlite, new Date().toISOString())
  expect(
    sqlite.prepare('SELECT id, phase, closed_reason FROM approvals ORDER BY id').all(),
  ).toEqual([
    { id: 'done', phase: 'executed', closed_reason: null },
    { id: 'gw', phase: 'withdrawn', closed_reason: 'history_reset' },
  ])
  expect(actionable(sqlite, readApprovalRow(sqlite, 'gw')!)).toBe(false)
  database.close()
})

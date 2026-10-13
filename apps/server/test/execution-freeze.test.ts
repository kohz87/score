import { DatabaseSync } from 'node:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { resetDatabaseHistory, resetJournalHistory } from '../src/history-reset.ts'
import { confirmCopy } from '../src/installation.ts'
import { startServer } from '../src/start-server.ts'
import { CodingJournal } from '../src/domain/orchestration/coding-journal.ts'
import { codingProjection } from '../src/domain/orchestration/coding-checkpoint.ts'
import { GlobalFenceStore } from '../src/domain/orchestration/fence.ts'
import {
  ExecutionJournal,
  HISTORY_MARKER_FILE,
  JOURNAL_FILE,
} from '../src/domain/orchestration/journal.ts'
import { openMigrated } from './orchestration/harness-db.ts'

// FV (decision 71): rare combined states (a copied home, a missing or truncated execution journal) freeze all agent work
// until `reset-history`; nothing retires or reconciles them automatically, and the reset never re-sends anything.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-copy-ret-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const AT = '2026-10-12T00:00:00.000Z'

const configFor = (home: string) =>
  loadConfig({
    SCORE_HOME: home,
    SCORE_MODE: 'fake',
    SCORE_FAKE_SPEED: '100',
    SCORE_FAKE_LOOP: 'false',
    SCORE_JOURNAL_DIR: join(root, 'journal'),
  })
const run = async (home: string) => {
  const server = await startServer(configFor(home), {
    logger: false,
    listen: async (app) => void (await app.ready()),
  })
  return server
}

function seedSource(db: string): void {
  const sqlite = new DatabaseSync(db)
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('ci-1', 'start_coding_run', 'turn-src', '{}', 'pending', ?, ?)`,
    )
    .run(AT, AT)
  // A pre-journal process-group row: no coding launch explains it.
  sqlite
    .prepare(
      `INSERT INTO coding_processes (run_id, pid, pgid, created_at) VALUES ('run-src', 4242, 4242, ?)`,
    )
    .run(AT)
  sqlite
    .prepare(
      `INSERT INTO coding_process_members (run_id, pid, start_time, seen_at) VALUES ('run-src', 4243, '1', ?)`,
    )
    .run(AT)
  sqlite
    .prepare(
      `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
         gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
         acknowledgement, preflight, reserve_bytes, created_at, updated_at)
       VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
    )
    .run(AT, AT)
  sqlite
    .prepare(
      `INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id,
         message_id, state, input, created_at, updated_at)
       VALUES ('att-src', 'o1', 'lead', 1, 'lead', 'i', 's', 'turn-att', 'm', 'created', '', ?, ?)`,
    )
    .run(AT, AT)
  sqlite.close()
}

const read = (db: string, sql: string) => {
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    return sqlite.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    sqlite.close()
  }
}

const REASON = /reset-history/

test('a confirmed copy freezes, keeps everything it inherited untouched, survives a restore of its own backup and restarts', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const first = await run(home)
  await first.close()
  seedSource(join(home, 'score.db'))
  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  rmSync(join(copy, 'score.pid'), { force: true })
  const confirmed = confirmCopy({ journalDir: join(root, 'journal'), home: copy })
  if (!confirmed.ok) throw new Error(confirmed.message)
  const ns = join(root, 'journal', confirmed.id)
  // The copy's pre-start database is "the backup of the confirmed copy" a person may restore later.
  const backup = join(root, 'copy-backup.db')
  cpSync(join(copy, 'score.db'), backup)
  // No retirement record is written on confirmation any more.
  const journal = new ExecutionJournal(ns, confirmed.id)
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(entries.entries.map((e) => e.kind)).not.toContain('inherited-retired')

  const state = (db: string) => ({
    intent: read(db, "SELECT state FROM command_intents WHERE idempotency_key = 'turn-src'")[0],
    processes: read(db, "SELECT run_id FROM coding_processes WHERE run_id = 'run-src'"),
    attempt: read(db, "SELECT state FROM orc_attempts WHERE id = 'att-src'")[0],
    frozen: read(db, 'SELECT frozen_reason, fenced FROM orc_global')[0],
  })
  const untouched = {
    intent: { state: 'pending' },
    processes: [{ run_id: 'run-src' }],
    attempt: { state: 'created' },
  }
  const second = await run(copy)
  await second.close()
  expect(state(join(copy, 'score.db'))).toMatchObject({
    ...untouched,
    frozen: { frozen_reason: expect.stringMatching(/copy of installation/), fenced: 1 },
  })

  // A restored backup lost the flag: the registry still says this home is a copy, so the next start freezes again.
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(copy, `score.db${suffix}`), { force: true })
  cpSync(backup, join(copy, 'score.db'))
  expect(state(join(copy, 'score.db')).frozen).toMatchObject({ frozen_reason: null })
  const third = await run(copy)
  await third.close()
  expect(state(join(copy, 'score.db'))).toMatchObject({
    ...untouched,
    frozen: { frozen_reason: expect.stringMatching(/copy of installation/), fenced: 1 },
  })
}, 60_000)

const fenceOf = (dir: string, id: string) => {
  const database = openMigrated(dir)
  const journal = new ExecutionJournal(join(dir, 'ns'), id)
  return { database, journal, store: new GlobalFenceStore(database, journal) }
}
const again = (dir: string, id: string, database: ReturnType<typeof openMigrated>) =>
  new GlobalFenceStore(database, new ExecutionJournal(join(dir, 'ns'), id))

test('the person-facing sentence, and an unresolved installation freezing with its own instructions', () => {
  const dir = join(root, 'sentence')
  mkdirSync(dir)
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.executionFrozen()).toBeNull()
  expect(store.frozenNotice()).toBeNull()
  store.setHardBlock(
    'This home is at a path Score does not know. Run `score installation confirm-copy`.',
  )
  expect(store.executionFrozen()).toMatch(/does not know/)
  expect(store.frozenNotice()).toMatch(/^Score is holding all agent work: This home is at a path/)
  // Its own instructions: reset-history is not the way out of an unresolved installation.
  expect(store.frozenNotice()).not.toMatch(REASON)
  store.freeze('the execution journal does not exist')
  store.setHardBlock(null)
  expect(store.frozenNotice()).toBe(
    'Score is holding all agent work: the execution journal does not exist. Run scripts/score installation reset-history to continue.',
  )
  database.close()
})

test('a missing journal freezes, and the freeze outlives the restart that recreates the journal; the lift is refused', () => {
  const dir = join(root, 'fence')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] }) // genuinely fresh
  journal.append({
    kind: 'send_started',
    attemptId: 'a1',
    orchestrationId: 'o1',
    attemptKind: 'step',
    agentId: 'builder',
    generation: 0,
  })
  expect(existsSync(join(dir, 'ns', HISTORY_MARKER_FILE))).toBe(true)
  rmSync(join(dir, 'ns', JOURNAL_FILE))
  const second = again(dir, 'ns-id', database)
  expect(second.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(second.executionFrozen()).toMatch(/history\.json/)
  // A later start (the journal file may exist again by then) is frozen without detecting anything.
  const third = again(dir, 'ns-id', database)
  expect(third.executionFrozen()).toMatch(/history\.json/)
  expect(() => third.lift(third.view().revision, 'checked')).toThrow(REASON)
  expect(third.view().fenced).toBe(true)
  database.close()
})

test('a missing journal with launch folders present freezes; an empty launch folder is not evidence', () => {
  const dir = join(root, 'fence2')
  mkdirSync(join(dir, 'ns', 'launches', 'empty'), { recursive: true })
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'ended.json'), '{}')
  const second = again(dir, 'ns-id', database)
  expect(second.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(second.executionFrozen()).toMatch(/L1/)
  database.close()
})

test('a launch folder the journal has no launch for freezes even though the journal exists, and no lift ever accounts for it', () => {
  const dir = join(root, 'fence3')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  const coding = new CodingJournal(journal)
  expect(
    coding.requestLaunch({ launchId: 'known', runId: 'r', turnId: 't', generation: 1 }).ok,
  ).toBe(true)
  mkdirSync(join(dir, 'ns', 'launches', 'known'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'known', 'x.json'), '{}')
  mkdirSync(join(dir, 'ns', 'launches', 'stray'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'stray', 'x.json'), '{}')
  const result = store.startupCheck()
  expect(result.fenced).toBe(true)
  expect(result.reasons).toContain('journal_truncated')
  expect(store.executionFrozen()).toMatch(/stray/)
  expect(store.view().items.map((item) => item.ref)).toContain('launch-folder:stray')
  expect(store.view().items.map((item) => item.ref)).not.toContain('launch-folder:known')
  // The lift is refused, and a restart after the stray folder's time still reports it (no timestamp acceptance).
  expect(() => store.lift(store.view().revision, undefined)).toThrow(REASON)
  const restart = again(dir, 'ns-id', database)
  expect(restart.startupCheck().reasons).toContain('journal_truncated')
  expect(restart.view().items.map((item) => item.ref)).toContain('launch-folder:stray')
  database.close()
})

test('a journal truncated to an empty file or an older prefix, with receipts and rows surviving, freezes (re-review 4 #5)', () => {
  const dir = join(root, 'fence4')
  mkdirSync(dir)
  const { journal, store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  const coding = new CodingJournal(journal)
  const project = codingProjection(database)
  expect(
    coding.requestLaunch({ launchId: 'L1', runId: 'r1', turnId: 't1', generation: 1 }, project).ok,
  ).toBe(true)
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'released.json'), '{}')
  // The journal is cut back to nothing; SQLite and the receipts keep what happened.
  writeFileSync(join(dir, 'ns', JOURNAL_FILE), '')
  const restart = again(dir, 'ns-id', database)
  const result = restart.startupCheck()
  expect(result.reasons).toContain('journal_truncated')
  expect(restart.executionFrozen()).toMatch(/lost/)
  expect(() => restart.lift(restart.view().revision, undefined)).toThrow(REASON)
  database.close()
})

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
  const done = resetDatabaseHistory(database.sqlite, '2026-10-13T00:00:00.000Z')
  expect(done).toMatchObject({ attempts: 1, launches: 1 })
  const rows = (sql: string) => database.sqlite.prepare(sql).all()
  expect(rows('SELECT id, state, stop_state FROM command_intents ORDER BY id')).toEqual([
    { id: 'i1', state: 'accepted', stop_state: 'done' },
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
  expect(fresh.entries.map((e) => e.kind)).toEqual(['history-reset'])
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

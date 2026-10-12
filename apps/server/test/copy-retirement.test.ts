import { DatabaseSync } from 'node:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { confirmCopy } from '../src/installation.ts'
import { startServer } from '../src/start-server.ts'
import { CodingJournal } from '../src/domain/orchestration/coding-journal.ts'
import { GlobalFenceStore } from '../src/domain/orchestration/fence.ts'
import {
  ExecutionJournal,
  HISTORY_MARKER_FILE,
  JOURNAL_FILE,
} from '../src/domain/orchestration/journal.ts'
import { openMigrated } from './orchestration/harness-db.ts'

// FZ3 (decision 69): what a confirmed copy inherited is retired in ITS journal, so restoring the copy's own backup can
// never bring it back; a namespace that had execution history never reads as fresh.

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

test('#4/#6: a confirmed copy retires what it inherited in its journal; restoring the copy’s backup never brings it back', async () => {
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

  // The record exists before the copy is ever started, with every inherited identity (incl. the legacy process row).
  const journal = new ExecutionJournal(ns, confirmed.id)
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(entries.entries.find((e) => e.kind === 'inherited-retired')).toMatchObject({
    intents: ['turn-src'],
    processes: ['run-src'],
    attempts: ['att-src'],
  })
  expect(new CodingJournal(journal).ownsProcessRow('run-src')).toBe(false)
  expect(new CodingJournal(journal).ownsProcessRow('run-own')).toBe(true)

  const second = await run(copy)
  await second.close()
  const afterFirstStart = (db: string) => ({
    intent: read(db, "SELECT state FROM command_intents WHERE idempotency_key = 'turn-src'")[0],
    processes: read(db, "SELECT run_id FROM coding_processes WHERE run_id = 'run-src'"),
    members: read(db, "SELECT run_id FROM coding_process_members WHERE run_id = 'run-src'"),
    attempt: read(db, "SELECT state FROM orc_attempts WHERE id = 'att-src'")[0],
  })
  expect(afterFirstStart(join(copy, 'score.db'))).toEqual({
    intent: { state: 'failed' },
    processes: [],
    members: [],
    attempt: { state: 'unknown' },
  })

  // Restore the copy's backup (as scripts/restore.mjs would: the home is replaced, a restore marker is left).
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(copy, `score.db${suffix}`), { force: true })
  cpSync(backup, join(copy, 'score.db'))
  expect(afterFirstStart(join(copy, 'score.db')).intent).toEqual({ state: 'pending' })
  writeFileSync(
    join(ns, 'restore-marker.json'),
    JSON.stringify({ scope: confirmed.id, at: AT, backup: 'copy-backup', origin: 'restore' }),
  )
  const third = await run(copy)
  await third.close()
  expect(afterFirstStart(join(copy, 'score.db'))).toEqual({
    intent: { state: 'failed' },
    processes: [],
    members: [],
    attempt: { state: 'unknown' },
  })
  // And the same without a marker (a plain start of a restored database).
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(join(copy, `score.db${suffix}`), { force: true })
  cpSync(backup, join(copy, 'score.db'))
  const fourth = await run(copy)
  await fourth.close()
  expect(afterFirstStart(join(copy, 'score.db')).intent).toEqual({ state: 'failed' })
}, 60_000)

test('#6: an unreadable copied database refuses the confirmation instead of publishing a copy with unknown inheritance', () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const journalDir = join(root, 'journal')
  const copy = join(root, 'home-copy')
  mkdirSync(copy)
  // Same installation id in both homes (the copy was made by copying the folder).
  return import('../src/installation.ts').then(({ resolveInstallation }) => {
    const resolved = resolveInstallation({ journalDir, home })
    if (!resolved.ok) throw new Error(resolved.message)
    cpSync(join(home, 'installation.json'), join(copy, 'installation.json'))
    writeFileSync(join(copy, 'score.db'), 'this is not a database')
    expect(confirmCopy({ journalDir, home: copy })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/can't be read/),
    })
  })
})

const fenceOf = (dir: string, id: string) => {
  const database = openMigrated(dir)
  const journal = new ExecutionJournal(join(dir, 'ns'), id)
  return { database, journal, store: new GlobalFenceStore(database, journal) }
}

test('#13: a missing journal in a namespace that had history fences instead of reading as fresh', () => {
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
  // The database was restored to before the send: it has no admissions either.
  const again = new GlobalFenceStore(database, new ExecutionJournal(join(dir, 'ns'), 'ns-id'))
  expect(again.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(again.view().items[0]!.detail).toMatch(/history\.json/)
  database.close()
})

test('#13: a missing journal with launch folders present fences; an empty launch folder is not evidence', () => {
  const dir = join(root, 'fence2')
  mkdirSync(join(dir, 'ns', 'launches', 'empty'), { recursive: true })
  const { store, database } = fenceOf(dir, 'ns-id')
  expect(store.startupCheck()).toEqual({ fenced: false, reasons: [] })
  mkdirSync(join(dir, 'ns', 'launches', 'L1'), { recursive: true })
  writeFileSync(join(dir, 'ns', 'launches', 'L1', 'ended.json'), '{}')
  const again = new GlobalFenceStore(database, new ExecutionJournal(join(dir, 'ns'), 'ns-id'))
  expect(again.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_missing'] })
  expect(again.view().items[0]!.detail).toMatch(/L1/)
  database.close()
})

test('#13: a launch folder the journal has no launch for is a lost witness even when the journal exists', () => {
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
  // (the database lacks the known launch's row too; this assertion is about the stray folder)
  const result = store.startupCheck()
  expect(result.fenced).toBe(true)
  expect(store.view().items.map((item) => item.ref)).toContain('launch-folder:stray')
  expect(store.view().items.map((item) => item.ref)).not.toContain('launch-folder:known')
  expect(readFileSync(join(dir, 'ns', JOURNAL_FILE), 'utf8')).toContain('known')
  database.close()
})

test('FW #1: a confirmed copy retires journaled refusals, running attempts, their owed Stops and every intent kind', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  const first = await run(home)
  await first.close()
  const sourceId = (
    JSON.parse(readFileSync(join(home, 'installation.json'), 'utf8')) as { id: string }
  ).id
  const sqlite = new DatabaseSync(join(home, 'score.db'))
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite
    .prepare(
      `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
         gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
         acknowledgement, preflight, reserve_bytes, created_at, updated_at)
       VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
    )
    .run(AT, AT)
  const attempt = (id: string, state: string, runId: string | null, stop: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO orc_attempts (id, orchestration_id, kind, n, agent_id, agent_incarnation, session_id, turn_id,
           message_id, state, input, run_id, stop_requested_at, created_at, updated_at)
         VALUES (?, 'o1', 'lead', 1, 'lead', 'i', 's', ?, 'm', ?, '', ?, ?, ?, ?)`,
      )
      .run(id, `turn-${id}`, state, runId, stop, AT, AT)
  attempt('att-ref', 'created', null, null)
  attempt('att-run', 'running', 'source-live-run', AT)
  sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('ci-h', 'start_run', 'turn-hermes', '{}', 'sent', ?, ?)`,
    )
    .run(AT, AT)
  sqlite.close()
  // The source's journal witnessed the first dispatch and a proven refusal: reconciliation leaves such an attempt sendable.
  const sourceJournal = new ExecutionJournal(join(root, 'journal', sourceId), sourceId)
  sourceJournal.append({
    kind: 'send_started',
    attemptId: 'att-ref',
    orchestrationId: 'o1',
    attemptKind: 'lead',
    agentId: 'lead',
    generation: 1,
  })
  sourceJournal.append({
    kind: 'send_refused',
    attemptId: 'att-ref',
    orchestrationId: 'o1',
    generation: 1,
  })

  const copy = join(root, 'home-copy')
  cpSync(home, copy, { recursive: true })
  rmSync(join(copy, 'score.pid'), { force: true })
  const confirmed = confirmCopy({ journalDir: join(root, 'journal'), home: copy })
  if (!confirmed.ok) throw new Error(confirmed.message)
  const second = await run(copy)
  await second.close()
  expect(
    read(
      join(copy, 'score.db'),
      `SELECT id, state, unknown_reason, stop_acknowledged_at IS NOT NULL AS acked FROM orc_attempts ORDER BY id`,
    ),
  ).toEqual([
    { id: 'att-ref', state: 'unknown', unknown_reason: 'inherited_retired', acked: 0 },
    { id: 'att-run', state: 'unknown', unknown_reason: 'inherited_retired', acked: 1 },
  ])
  expect(
    read(join(copy, 'score.db'), "SELECT state FROM command_intents WHERE id = 'ci-h'"),
  ).toEqual([{ state: 'failed' }])
}, 60_000)

test('FW #1: a confirmed copy without its retirement record owns no process row; unreadable history owns none either', () => {
  const dir = join(root, 'own')
  mkdirSync(dir)
  const journal = new ExecutionJournal(dir, 'ns-own')
  journal.append({
    kind: 'send_started',
    attemptId: 'a',
    orchestrationId: 'o',
    attemptKind: 'lead',
    agentId: 'lead',
    generation: 1,
  })
  const coding = new CodingJournal(journal)
  expect(coding.ownsProcessRow('run-x')).toBe(true) // not a copy: no evidence either way is ours
  expect(coding.ownsProcessRow('run-x', true)).toBe(false) // a copy whose retirement record is gone
  writeFileSync(join(dir, JOURNAL_FILE), 'garbage\n')
  expect(coding.ownsProcessRow('run-x')).toBe(false)
})

import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ScoreDb } from '../../src/db/index.ts'
import { GlobalFenceStore, readGlobal, verifyJournal } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, JOURNAL_FILE, RESTORE_MARKER_FILE } from '../../src/domain/orchestration/journal.ts'
import { openMigrated, tempDir } from './harness-db.ts'

const AT = '2026-10-10T10:00:00.000Z'
let tmp: ReturnType<typeof tempDir>
let db: ScoreDb
let journalDir: string
let clockNow: number
const clock = () => clockNow
const journalOf = (scope = 'home-a') => new ExecutionJournal(journalDir, scope, clock)

// A minimal orchestration + attempt, enough for the journal checks.
function seedAttempt(database: ScoreDb, attemptId: string, sentAt: string | null, runId: string | null) {
  database.sqlite.exec('PRAGMA foreign_keys = OFF')
  database.tx((sqlite) => {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id,
         gate_policy, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd, status,
         acknowledgement, preflight, reserve_bytes, created_at, updated_at)
         VALUES ('o1', 't', 'g', 'lead', 'i', '[]', 'r', 'b', 'none', 1, 1, 1, 1, 1, 'running', '{}', '{}', 0, ?, ?)`,
      )
      .run(AT, AT)
    sqlite
      .prepare(
        `INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id,
         message_id, state, input, run_id, sent_at, created_at, updated_at)
         VALUES (?, 'o1', 'step', 's1', 1, 'builder', 'i', ?, ?, ?, 'running', '', ?, ?, ?, ?)`,
      )
      .run(attemptId, attemptId, `turn-${attemptId}`, `reply:${attemptId}`, runId, sentAt, AT, AT)
  })
  database.sqlite.exec('PRAGMA foreign_keys = ON')
}

beforeEach(() => {
  tmp = tempDir('orc-journal-')
  journalDir = join(tmp.dir, 'journal')
  db = openMigrated(tmp.dir)
  clockNow = Date.parse(AT)
})
afterEach(() => {
  db.close()
  tmp.cleanup()
})

test('appends entries with a checksum and reads them back in order', () => {
  const journal = journalOf()
  expect(journal.open()).toBe(true)
  journal.append({ kind: 'send_started', attemptId: 'a1', orchestrationId: 'o1', attemptKind: 'step', agentId: 'builder', generation: 0 })
  journal.append({ kind: 'run_handle', attemptId: 'a1', runId: 'run-1' })
  const read = journalOf().readOwn()
  expect(read.ok && read.entries.map((entry) => [entry.n, entry.kind])).toEqual([
    [1, 'send_started'],
    [2, 'run_handle'],
  ])
})

test('a journal shared by two homes keeps their entries apart', () => {
  journalOf('home-a').append({ kind: 'reconciled', attemptId: 'x' })
  journalOf('home-b').append({ kind: 'reconciled', attemptId: 'y' })
  const a = journalOf('home-a').readOwn()
  expect(a.ok && a.entries.map((entry) => entry.kind === 'reconciled' && entry.attemptId)).toEqual(['x'])
})

test('a torn last line is dropped (its effect never started) and appends stay aligned', () => {
  const journal = journalOf()
  journal.append({ kind: 'reconciled', attemptId: 'x' })
  appendFileSync(join(journalDir, JOURNAL_FILE), '{"kind":"send_sta')
  const reopened = journalOf()
  expect(reopened.open()).toBe(true)
  reopened.append({ kind: 'reconciled', attemptId: 'y' })
  const read = journalOf().readOwn()
  expect(read.ok && read.entries).toHaveLength(2)
})

test('a damaged line in the middle makes the journal unreadable', () => {
  const journal = journalOf()
  journal.append({ kind: 'reconciled', attemptId: 'x' })
  journal.append({ kind: 'reconciled', attemptId: 'y' })
  const file = join(journalDir, JOURNAL_FILE)
  writeFileSync(file, readFileSync(file, 'utf8').replace('"x"', '"z"'))
  expect(journalOf().read().ok).toBe(false)
  expect(journalOf().open()).toBe(false)
  expect(() => {
    const broken = journalOf()
    broken.read()
    broken.append({ kind: 'reconciled', attemptId: 'q' })
  }).toThrow()
})

test('compaction drops only entries the caller marks reconciled and keeps numbering', () => {
  const journal = journalOf()
  journal.append({ kind: 'send_started', attemptId: 'a1', orchestrationId: 'o1', attemptKind: 'step', agentId: 'b', generation: 0 })
  journal.append({ kind: 'send_started', attemptId: 'a2', orchestrationId: 'o1', attemptKind: 'step', agentId: 'b', generation: 0 })
  const result = journal.compact((entry) => 'attemptId' in entry && entry.attemptId === 'a1')
  expect(result).toEqual({ kept: 1, dropped: 1 })
  const next = journal.append({ kind: 'reconciled', attemptId: 'a2' })
  expect(next.n).toBe(3)
})

test('startup: a database that holds everything the journal says is not fenced', () => {
  seedAttempt(db, 'a1', AT, 'run-1')
  const journal = journalOf()
  journal.append({ kind: 'send_started', attemptId: 'a1', orchestrationId: 'o1', attemptKind: 'step', agentId: 'builder', generation: 0 })
  journal.append({ kind: 'run_handle', attemptId: 'a1', runId: 'run-1' })
  const result = new GlobalFenceStore(db, journalOf(), clock).startupCheck()
  expect(result).toEqual({ fenced: false, reasons: [] })
})

test('database-only restore is detected: journal entries the database lacks fence everything', () => {
  const backup = join(tmp.dir, 'before.db')
  db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  copyFileSync(join(tmp.dir, 'score.db'), backup)
  seedAttempt(db, 'a1', AT, 'run-1')
  const journal = journalOf()
  journal.append({ kind: 'send_started', attemptId: 'a1', orchestrationId: 'o1', attemptKind: 'step', agentId: 'builder', generation: 0 })
  journal.append({ kind: 'run_handle', attemptId: 'a1', runId: 'run-1' })
  db.close()
  // Roll the database back to before the admission; the journal (outside the home) is not rolled back.
  copyFileSync(backup, join(tmp.dir, 'score.db'))
  for (const suffix of ['-wal', '-shm']) writeFileSync(join(tmp.dir, `score.db${suffix}`), '')
  db = openMigrated(tmp.dir)
  const store = new GlobalFenceStore(db, journalOf(), clock)
  const result = store.startupCheck()
  expect(result.fenced).toBe(true)
  expect(result.reasons).toEqual(['journal_mismatch'])
  const view = store.view()
  expect(view.fenced).toBe(true)
  expect(view.items.map((item) => item.kind).sort()).toEqual(['attempt', 'handle'])
  expect(view.items.map((item) => item.ref)).toEqual(['a1', 'a1'])
})

test('restore after a Stop with an unchanged dispatch counter is detected through the Stop fence entry', () => {
  seedAttempt(db, 'a1', AT, 'run-1')
  const journal = journalOf()
  journal.append({ kind: 'send_started', attemptId: 'a1', orchestrationId: 'o1', attemptKind: 'step', agentId: 'builder', generation: 0 })
  journal.append({ kind: 'run_handle', attemptId: 'a1', runId: 'run-1' })
  // Snapshot of the database taken before Stop: it still holds the admission.
  db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const backup = join(tmp.dir, 'pre-stop.db')
  copyFileSync(join(tmp.dir, 'score.db'), backup)
  journal.append({ kind: 'stop_fence', orchestrationId: 'o1', reason: 'stop' })
  db.tx((sqlite) => sqlite.prepare("UPDATE orchestrations SET stop_requested_at = ?, status = 'stopping' WHERE id = 'o1'").run(AT))
  expect(new GlobalFenceStore(db, journalOf(), clock).startupCheck().fenced).toBe(false)
  db.close()
  copyFileSync(backup, join(tmp.dir, 'score.db'))
  for (const suffix of ['-wal', '-shm']) writeFileSync(join(tmp.dir, `score.db${suffix}`), '')
  db = openMigrated(tmp.dir)
  const store = new GlobalFenceStore(db, journalOf(), clock)
  expect(store.startupCheck().fenced).toBe(true)
  const items = store.view().items
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ kind: 'fence', ref: 'o1' })
})

test('an unreadable journal fences', () => {
  const journal = journalOf()
  journal.append({ kind: 'reconciled', attemptId: 'x' })
  journal.append({ kind: 'reconciled', attemptId: 'y' })
  const file = join(journalDir, JOURNAL_FILE)
  writeFileSync(file, readFileSync(file, 'utf8').replace('"y"', '"w"'))
  const store = new GlobalFenceStore(db, journalOf(), clock)
  expect(store.startupCheck()).toEqual({ fenced: true, reasons: ['journal_unreadable'] })
  expect(store.view().journal.ok).toBe(false)
})

test('a deleted journal fences when the database remembers admissions', () => {
  seedAttempt(db, 'a1', AT, 'run-1')
  const store = new GlobalFenceStore(db, journalOf(), clock)
  expect(store.startupCheck().reasons).toEqual(['journal_missing'])
})

test('a restore marker (left by the restore script) fences and marks history untrusted, once', () => {
  const journal = journalOf()
  journal.open()
  writeFileSync(
    join(journalDir, RESTORE_MARKER_FILE),
    JSON.stringify({ scope: 'home-a', at: AT, backup: '/backups/score-1' }),
  )
  const store = new GlobalFenceStore(db, journalOf(), clock)
  expect(store.startupCheck()).toEqual({ fenced: true, reasons: ['restore'] })
  expect(db.read((sqlite) => readGlobal(sqlite).untrusted_history)).toBe(1)
  const view = store.view()
  expect(view.untrustedHistory).toBe(true)
  expect(view.items[0]).toMatchObject({ kind: 'restore', ref: '/backups/score-1' })
  // The marker is consumed: the second start does not add another doubt, but the fence stays.
  const second = new GlobalFenceStore(db, journalOf(), clock).startupCheck()
  expect(second).toEqual({ fenced: true, reasons: [] })
  // A marker for another home is ignored.
  writeFileSync(join(journalDir, RESTORE_MARKER_FILE), JSON.stringify({ scope: 'other', at: AT, backup: 'x' }))
  expect(journalOf().readRestoreMarker()).toBeUndefined()
})

test('lifting needs the current revision, journals the accepted entries and does not re-fence next start', () => {
  seedAttempt(db, 'a1', AT, 'run-1')
  const journal = journalOf()
  journal.append({ kind: 'send_started', attemptId: 'ghost', orchestrationId: 'o1', attemptKind: 'step', agentId: 'builder', generation: 0 })
  const store = new GlobalFenceStore(db, journalOf(), clock)
  expect(store.startupCheck().fenced).toBe(true)
  const view = store.view()
  expect(() => store.lift(view.revision + 5, undefined)).toThrow(/changed/)
  store.lift(view.revision, 'checked the ghost')
  expect(store.view().fenced).toBe(false)
  // The lifted journal entry is accepted, so the next start sees no doubt.
  const again = new GlobalFenceStore(db, journalOf(), clock)
  expect(again.startupCheck()).toEqual({ fenced: false, reasons: [] })
  const read = journalOf().readOwn()
  expect(read.ok && verifyJournal(db.sqlite, read.entries)).toEqual([])
})

test('a fence the database lost is restored from the journal (lifted journal entry is newer than the database)', () => {
  const store = new GlobalFenceStore(db, journalOf(), clock)
  store.set('journal_mismatch', [{ kind: 'journal', ref: 'x', journalN: null, detail: 'x' }])
  db.sqlite.exec("UPDATE orc_global SET fenced = 0, fence_seq = 0 WHERE id = 1")
  const again = new GlobalFenceStore(db, journalOf(), clock)
  expect(again.startupCheck().fenced).toBe(true)
})

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  HISTORY_MARKER,
  JOURNAL,
  LAUNCHES_DIR,
  lineChecksum,
  withRegistryLock,
  writeDurable,
} from './installation.ts'
import { acquireHomeLock } from './db/lock.ts'
import { LOCK_RANK, mkdirDurable, OsLock } from './locks/os-lock.ts'

// `scripts/score installation reset-history` (decision 71): the only way out of a frozen state (a copied home, a lost or
// truncated execution journal). The old journal and launch folders are archived beside a fresh journal whose first
// record is a permanent `history-reset`; the database retires every unfinished execution record. Nothing is ever sent,
// stopped or signalled for what was retired, and the freeze is lifted. Node built-ins and syntax Node can strip only:
// the script imports this file as it is (so it writes the journal record itself, like `confirmCopy` does).

function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Moves the namespace's journal, history marker and launch folders into a dated archive folder and starts a fresh journal
 * with its `history-reset` record. Order: archive, fresh directories, record. A crash in between leaves a namespace
 * whose database still remembers history, so the next start freezes again and the person simply runs the command again.
 * Works on a damaged journal too: it is archived, not read for meaning.
 */
export function resetJournalHistory(options: {
  journalDir: string
  namespaceDir: string
  installationId: string
  now?: Date
  generation?: string
}): { archive: string; archived: number; generation: string } {
  const at = options.now ?? new Date()
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const ns = options.namespaceDir
  const generation = options.generation ?? randomUUID()
  return withRegistryLock(options.journalDir, () => {
    mkdirDurable(ns)
    const lock = new OsLock(ns, fsyncSync, undefined, LOCK_RANK.journal)
    try {
      return lock.runSync(() => {
        const old = join(ns, JOURNAL)
        const archived = existsSync(old)
          ? readFileSync(old, 'utf8').split('\n').filter(Boolean).length
          : 0
        let archive = `history-before-reset-${stamp}`
        for (let n = 2; existsSync(join(ns, archive)); n++)
          archive = `history-before-reset-${stamp}-${n}`
        const target = join(ns, archive)
        mkdirSync(target, { mode: 0o700 })
        for (const name of [JOURNAL, HISTORY_MARKER, LAUNCHES_DIR]) {
          const from = join(ns, name)
          if (existsSync(from)) renameSync(from, join(target, name))
        }
        syncDirectory(target)
        syncDirectory(ns)
        mkdirDurable(join(ns, LAUNCHES_DIR))
        const record = {
          n: 1,
          at: at.toISOString(),
          scope: options.installationId,
          kind: 'history-reset',
          archive,
          archived,
          generation,
        }
        writeDurable(
          join(ns, JOURNAL),
          JSON.stringify({ ...record, c: lineChecksum(JSON.stringify(record)) }) + '\n',
        )
        writeDurable(join(ns, HISTORY_MARKER), JSON.stringify({ version: 1, at: at.toISOString() }))
        return { archive, archived, generation }
      })
    } finally {
      lock.close()
    }
  })
}

/** Appends the `history-reset-complete` record (fsync'd, then the directory): the reset is finished only after this. */
export function completeJournalHistory(options: {
  namespaceDir: string
  installationId: string
  generation: string
  now?: Date
}): void {
  const file = join(options.namespaceDir, JOURNAL)
  const raw = readFileSync(file, 'utf8')
  const last = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { n: number }).n)
    .at(-1)
  const record = {
    n: (last ?? 0) + 1,
    at: (options.now ?? new Date()).toISOString(),
    scope: options.installationId,
    kind: 'history-reset-complete',
    generation: options.generation,
  }
  const line = Buffer.from(
    JSON.stringify({ ...record, c: lineChecksum(JSON.stringify(record)) }) + '\n',
  )
  const fd = openSync(file, 'a', 0o600)
  try {
    let written = 0
    while (written < line.length) written += writeSync(fd, line, written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(options.namespaceDir)
}

/**
 * The whole reset, in the order that keeps every crash frozen (decision 72): hold the home lock and the journal's locks
 * from start to end; write the `history-reset` record with a new random generation; commit the database retirement and
 * the same generation durably; only then write `history-reset-complete`. A crash anywhere before the last record leaves
 * a reset without its completion, which freezes the next start, and the person simply runs the command again.
 */
export function resetHistory(options: {
  journalDir: string
  namespaceDir: string
  installationId: string
  home: string
  dbFile: string
  now?: Date
  /** The caller already holds `<home>/score.lock` (the command takes it before resolving the identity). */
  homeLockHeld?: boolean
}): { archive: string; archived: number; generation: string; database: DatabaseReset | null } {
  const at = options.now ?? new Date()
  mkdirDurable(options.home)
  // The same lock a running server holds for its lifetime (db/lock.ts): taken here unless the caller holds it, and
  // refused while another process (or this one) owns it (re-review 6 #6).
  const homeLock = options.homeLockHeld ? null : acquireHomeLock(options.home)
  try {
    const generation = randomUUID()
    // The journal and registry locks are taken (and released) inside; the home lock stays held around all of it, so
    // nothing that opens the database through the home lock can interleave with the retirement.
    const journal = resetJournalHistory({
      journalDir: options.journalDir,
      namespaceDir: options.namespaceDir,
      installationId: options.installationId,
      now: at,
      generation,
    })
    let database: DatabaseReset | null = null
    if (existsSync(options.dbFile)) {
      const sqlite = new DatabaseSync(options.dbFile)
      try {
        sqlite.exec('PRAGMA busy_timeout = 10000')
        database = resetDatabaseHistory(sqlite, at.toISOString(), generation)
        // The retirement must be on disk before the journal says the reset is complete.
        sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        sqlite.close()
      }
    }
    completeJournalHistory({
      namespaceDir: options.namespaceDir,
      installationId: options.installationId,
      generation,
      now: at,
    })
    return { ...journal, database }
  } finally {
    homeLock?.release()
  }
}

export interface DatabaseReset {
  attempts: number
  intents: number
  processes: number
  launches: number
}

/**
 * Retires every unfinished execution record in one transaction: orchestration attempts (and their owed Stops), start
 * intents (and their owed Stops), coding process rows, members, terminals, handles and launches. Launch rows stay as
 * permanent "never sent again" witnesses. Then the fence and the freeze are lifted.
 */
export function resetDatabaseHistory(
  sqlite: DatabaseSync,
  nowIso: string,
  generation: string = randomUUID(),
): DatabaseReset {
  const has = (table: string): boolean =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  const hasColumn = (table: string, column: string): boolean =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (row) => row.name === column,
    )
  const result: DatabaseReset = { attempts: 0, intents: 0, processes: 0, launches: 0 }
  const note = 'Its history was reset by the person; it is never sent, stopped or resumed again.'
  // The commit is on disk when it returns: the journal's completion record is written only after it.
  sqlite.exec('PRAGMA synchronous = FULL')
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    if (has('orc_attempts')) {
      result.attempts = Number(
        sqlite
          .prepare(
            `UPDATE orc_attempts SET state = CASE WHEN state IN ('created', 'send_started', 'running') THEN 'unknown' ELSE state END,
               unknown_reason = 'history_reset', sent_at = COALESCE(sent_at, ?), reserved_usd = 0,
               stop_acknowledged_at = CASE WHEN stop_requested_at IS NOT NULL THEN COALESCE(stop_acknowledged_at, ?) ELSE stop_acknowledged_at END,
               updated_at = ?
             WHERE state IN ('created', 'send_started', 'running', 'unknown', 'abandoned')`,
          )
          .run(nowIso, nowIso, nowIso).changes,
      )
      // Steps: queued and gated ones will never start, admitted ones are unknown; all are retired so a late result or a
      // reconciliation can never turn them back into live work (result consumption and scheduling skip retired steps).
      if (has('orc_steps'))
        sqlite
          .prepare(
            `UPDATE orc_steps SET status = CASE WHEN status IN ('pending_gate', 'queued') THEN 'not_started' ELSE 'unknown' END,
               disposition = 'history_reset', retired = 1, updated_at = ?
             WHERE status IN ('pending_gate', 'queued', 'admitted')`,
          )
          .run(nowIso)
      // The bearer authority of retired attempts ends with them.
      if (has('orc_capabilities'))
        sqlite
          .prepare(
            `UPDATE orc_capabilities SET expired_at = COALESCE(expired_at, ?)
             WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE unknown_reason = 'history_reset')`,
          )
          .run(nowIso)
    }
    if (has('command_intents')) {
      result.intents = Number(
        sqlite
          .prepare(
            `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ?
             WHERE state IN ('pending', 'sent', 'unknown')
                OR (kind = 'start_coding_run' AND state = 'accepted' AND result IS NULL)`,
          )
          .run(note, nowIso).changes,
      )
      // The turn of every coding launch is retired too (the launch rows below keep it unsendable).
      if (has('coding_launches'))
        result.intents += Number(
          sqlite
            .prepare(
              `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ?
               WHERE idempotency_key IN (SELECT turn_id FROM coding_launches)
                 AND NOT (state = 'failed' OR (state = 'accepted' AND result IS NOT NULL))`,
            )
            .run(note, nowIso).changes,
        )
      // An accepted start whose run row Score never saw is a handle to somebody else's run: nothing re-attaches to it.
      sqlite
        .prepare(
          `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ?
           WHERE kind = 'start_run' AND state = 'accepted'
             AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.score_turn_id = command_intents.idempotency_key)`,
        )
        .run(note, nowIso)
      // A Stop owed on an accepted intent's run belongs to the old history.
      if (hasColumn('command_intents', 'stop_state'))
        sqlite
          .prepare("UPDATE command_intents SET stop_state = 'done' WHERE stop_state = 'pending'")
          .run()
    }
    // Every unfinished chat reply, also an active one that already has a run: its bubble stops streaming and it can never
    // route a hand-off, accept late output as work or take a Stop (re-review 6 #3). Late evidence may still be shown as
    // history, but completeRunMessage and the dispatcher only act on `pending`/`active` replies.
    if (has('message_runs')) {
      if (has('messages'))
        sqlite
          .prepare(
            `UPDATE messages SET streaming = 0
             WHERE id IN (SELECT message_id FROM message_runs WHERE state IN ('pending', 'active'))`,
          )
          .run()
      sqlite
        .prepare(`UPDATE message_runs SET state = 'failed' WHERE state IN ('pending', 'active')`)
        .run()
    }
    // The run rows are the handles Stop, the follower, recovery and approvals look up: a retired run has none.
    if (has('runs')) {
      if (has('approvals'))
        sqlite
          .prepare(
            `UPDATE approvals SET phase = 'withdrawn', status = 'withdrawn', closed_reason = 'run_ended', closed_at = ?,
               updated_at = ?, version = version + 1
             WHERE phase IN ('guardian_evaluating', 'escalated', 'human_pending')
               AND run_id IN (SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting_for_approval'))`,
          )
          .run(nowIso, nowIso)
      sqlite
        .prepare(
          `UPDATE runs SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), error = COALESCE(error, ?),
             updated_at = ?, version = version + 1
           WHERE status IN ('queued', 'running', 'waiting_for_approval')`,
        )
        .run(nowIso, 'history_reset', nowIso)
    }
    // Decisions still owed to a run: never leased, retried or acknowledged as work again.
    if (has('approval_deliveries'))
      sqlite
        .prepare(
          `UPDATE approval_deliveries SET state = 'failed', error = 'history_reset', lease_until = NULL,
             next_attempt_at = NULL, updated_at = ?
           WHERE state IN ('intent', 'delivering', 'unknown')`,
        )
        .run(nowIso)
    for (const table of ['coding_processes', 'coding_process_members', 'coding_pending_terminals'])
      if (has(table))
        result.processes += Number(sqlite.prepare(`DELETE FROM ${table}`).run().changes)
    if (has('coding_launches')) {
      result.launches = Number(
        sqlite
          .prepare(
            `UPDATE coding_launches SET held = 0, unsendable = 1, revoked = 1, journal_n = 0,
               phase = CASE WHEN phase IN ('ended', 'settled') THEN phase ELSE 'settled' END`,
          )
          .run().changes,
      )
      if (has('coding_journal_checkpoint'))
        sqlite.prepare('UPDATE coding_journal_checkpoint SET seq = 0 WHERE id = 1').run()
    }
    if (has('orc_global')) {
      sqlite
        .prepare(
          `UPDATE orc_global SET fenced = 0, reason = NULL, untrusted_history = 0, lifted_at = ?,
             revision = revision + 1, admission_revision = admission_revision + 1 WHERE id = 1`,
        )
        .run(nowIso)
      if (hasColumn('orc_global', 'frozen_reason'))
        sqlite.prepare('UPDATE orc_global SET frozen_reason = NULL WHERE id = 1').run()
      if (hasColumn('orc_global', 'history_generation'))
        sqlite.prepare('UPDATE orc_global SET history_generation = ? WHERE id = 1').run(generation)
      if (has('orc_history'))
        sqlite
          .prepare(
            "INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (NULL, 'history_reset', ?, ?)",
          )
          .run(JSON.stringify(result), nowIso)
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
  return result
}

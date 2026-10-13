import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
} from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import {
  HISTORY_MARKER,
  JOURNAL,
  LAUNCHES_DIR,
  lineChecksum,
  withRegistryLock,
  writeDurable,
} from './installation.ts'
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
}): { archive: string; archived: number } {
  const at = options.now ?? new Date()
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const ns = options.namespaceDir
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
        }
        writeDurable(
          join(ns, JOURNAL),
          JSON.stringify({ ...record, c: lineChecksum(JSON.stringify(record)) }) + '\n',
        )
        writeDurable(join(ns, HISTORY_MARKER), JSON.stringify({ version: 1, at: at.toISOString() }))
        return { archive, archived }
      })
    } finally {
      lock.close()
    }
  })
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
export function resetDatabaseHistory(sqlite: DatabaseSync, nowIso: string): DatabaseReset {
  const has = (table: string): boolean =>
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  const hasColumn = (table: string, column: string): boolean =>
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (row) => row.name === column,
    )
  const result: DatabaseReset = { attempts: 0, intents: 0, processes: 0, launches: 0 }
  const note = 'Its history was reset by the person; it is never sent, stopped or resumed again.'
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    if (has('orc_attempts')) {
      result.attempts = Number(
        sqlite
          .prepare(
            `UPDATE orc_attempts SET state = CASE WHEN state IN ('created', 'send_started', 'running') THEN 'unknown' ELSE state END,
               unknown_reason = 'history_reset', sent_at = COALESCE(sent_at, ?),
               stop_acknowledged_at = CASE WHEN stop_requested_at IS NOT NULL THEN COALESCE(stop_acknowledged_at, ?) ELSE stop_acknowledged_at END,
               updated_at = ?
             WHERE state IN ('created', 'send_started', 'running', 'unknown', 'abandoned')`,
          )
          .run(nowIso, nowIso, nowIso).changes,
      )
      if (has('orc_steps'))
        sqlite
          .prepare(
            `UPDATE orc_steps SET status = 'unknown', disposition = 'history_reset', updated_at = ?
             WHERE status = 'admitted' AND EXISTS (
               SELECT 1 FROM orc_attempts a WHERE a.orchestration_id = orc_steps.orchestration_id
                 AND a.step_id = orc_steps.id AND a.unknown_reason = 'history_reset')`,
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
      // A Stop owed on an accepted intent's run belongs to the old history.
      if (hasColumn('command_intents', 'stop_state'))
        sqlite
          .prepare("UPDATE command_intents SET stop_state = 'done' WHERE stop_state = 'pending'")
          .run()
    }
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

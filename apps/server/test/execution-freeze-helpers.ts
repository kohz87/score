import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { GlobalFenceStore } from '../src/domain/orchestration/fence.ts'
import { ExecutionJournal } from '../src/domain/orchestration/journal.ts'
import {
  completeJournalHistory,
  resetDatabaseHistory,
  resetJournalHistory,
} from '../src/history-reset.ts'
import { startServer } from '../src/start-server.ts'
import { openMigrated } from './orchestration/harness-db.ts'

// FV (decision 71): rare combined states (a copied home, a missing or truncated execution journal) freeze all agent work
// until `reset-history`; nothing retires or reconciles them automatically, and the reset never re-sends anything.

export let root: string
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
export const run = async (home: string) => {
  const server = await startServer(configFor(home), {
    logger: false,
    listen: async (app) => void (await app.ready()),
  })
  return server
}

export function seedSource(db: string): void {
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

export const read = (db: string, sql: string) => {
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    return sqlite.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    sqlite.close()
  }
}

export const REASON = /reset-history/

export const fenceOf = (dir: string, id: string) => {
  const database = openMigrated(dir)
  const journal = new ExecutionJournal(join(dir, 'ns'), id)
  return { database, journal, store: new GlobalFenceStore(database, journal) }
}
export const again = (dir: string, id: string, database: ReturnType<typeof openMigrated>) =>
  new GlobalFenceStore(database, new ExecutionJournal(join(dir, 'ns'), id))

export const fullReset = (dir: string, database: ReturnType<typeof openMigrated>) => {
  const journal = resetJournalHistory({
    journalDir: dir,
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
  })
  resetDatabaseHistory(database.sqlite, new Date().toISOString(), journal.generation)
  completeJournalHistory({
    namespaceDir: join(dir, 'ns'),
    installationId: 'ns-id',
    generation: journal.generation,
  })
  return journal
}

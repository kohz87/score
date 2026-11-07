import { WORKFLOW_LIMITS, type StorageInventory } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import type { OrchRow } from '../orchestration/store.ts'

// ----------------------------------------------------------------------------------------------------- inventory

const one = <T>(sqlite: DatabaseSync, sql: string, ...args: (string | number)[]): T =>
  sqlite.prepare(sql).get(...args) as T

export function storageInventory(sqlite: DatabaseSync, o: OrchRow): StorageInventory {
  const id = o.id
  // A coding worker's dispatch generations each have a turn id of their own, with runs and intents attached to it
  // (pruning deletes by the same set).
  const turnIds = (
    sqlite
      .prepare(
        `SELECT turn_id FROM orc_attempts WHERE orchestration_id = ?1
         UNION SELECT turn_id FROM orc_generations WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?1)`,
      )
      .all(id) as { turn_id: string }[]
  ).map((r) => r.turn_id)
  const marks = turnIds.map(() => '?').join(',') || "''"
  const sum = (sql: string, ...args: (string | number)[]) =>
    one<{ n: number; b: number }>(sqlite, sql, ...args)
  const orc = {
    steps: sum(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(instruction AS BLOB)) + LENGTH(CAST(COALESCE(result, '') AS BLOB))), 0) AS b FROM orc_steps WHERE orchestration_id = ?",
      id,
    ),
    attempts: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(input AS BLOB))), 0) AS b FROM orc_attempts WHERE orchestration_id = ?',
      id,
    ),
    gates: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS b FROM orc_gates WHERE orchestration_id = ?',
      id,
    ),
  }
  const wfRows = {
    nodes: sum(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(COALESCE(output, '') AS BLOB)) + LENGTH(CAST(COALESCE(reason, '') AS BLOB))), 0) AS b FROM wf_nodes WHERE orchestration_id = ?",
      id,
    ),
    gates: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS b FROM wf_gates WHERE orchestration_id = ?',
      id,
    ),
    other: sum(
      'SELECT (SELECT COUNT(*) FROM wf_tokens WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM wf_consumed WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM wf_steps WHERE orchestration_id = ?1) AS n, 0 AS b',
      id,
    ),
    results: sum(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(output AS BLOB))), 0) AS b FROM wf_results WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)`,
      id,
    ),
  }
  const receipts = sum(
    'SELECT (SELECT COUNT(*) FROM wf_commands WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM orc_commands WHERE orchestration_id = ?1) AS n, COALESCE((SELECT SUM(LENGTH(CAST(receipt AS BLOB))) FROM wf_commands WHERE orchestration_id = ?1), 0) + COALESCE((SELECT SUM(LENGTH(CAST(receipt AS BLOB))) FROM orc_commands WHERE orchestration_id = ?1), 0) AS b',
    id,
  )
  const intents = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS b FROM command_intents WHERE idempotency_key IN (${marks})`,
    ...turnIds,
  )
  const messages = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(parts AS BLOB))), 0) AS b FROM messages WHERE room_id = ?',
    o.room_id,
  )
  const messageRuns = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(input AS BLOB))), 0) AS b FROM message_runs WHERE orchestration_attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
    id,
  )
  const runs = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(COALESCE(output, '') AS BLOB))), 0) AS b FROM runs WHERE score_turn_id IN (${marks})`,
    ...turnIds,
  )
  const tools = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(COALESCE(preview, '') AS BLOB)) + LENGTH(CAST(COALESCE(result_preview, '') AS BLOB))), 0) AS b FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE score_turn_id IN (${marks}))`,
    ...turnIds,
  )
  const thinking = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS b FROM run_thinking WHERE run_id IN (SELECT id FROM runs WHERE score_turn_id IN (${marks}))`,
    ...turnIds,
  )
  const history = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(detail AS BLOB))), 0) AS b FROM orc_history WHERE orchestration_id = ?',
    id,
  )
  const compacted = one<{ detail: string } | undefined>(
    sqlite,
    "SELECT detail FROM orc_history WHERE orchestration_id = ? AND kind = 'compacted_control' LIMIT 1",
    id,
  )
  return {
    reserveBytes: o.reserve_bytes,
    storedBytes: o.stored_bytes,
    protectedBytes: WORKFLOW_LIMITS.protectedBytes,
    items: [
      {
        kind: 'orchestration_rows',
        rows: 1 + orc.steps.n + orc.attempts.n + orc.gates.n,
        bytes: orc.steps.b + orc.attempts.b + orc.gates.b,
      },
      {
        kind: 'workflow_rows',
        rows: wfRows.nodes.n + wfRows.gates.n + wfRows.other.n + wfRows.results.n,
        bytes: wfRows.nodes.b + wfRows.gates.b + wfRows.results.b,
      },
      { kind: 'receipts', rows: receipts.n, bytes: receipts.b },
      { kind: 'intents', rows: intents.n, bytes: intents.b },
      { kind: 'room_messages', rows: messages.n, bytes: messages.b },
      { kind: 'message_runs', rows: messageRuns.n, bytes: messageRuns.b },
      { kind: 'attempt_runs', rows: runs.n, bytes: runs.b },
      { kind: 'tool_rows', rows: tools.n, bytes: tools.b },
      { kind: 'thinking', rows: thinking.n, bytes: thinking.b },
      { kind: 'control_history', rows: history.n, bytes: history.b },
    ],
    compactedControlRecords: compacted
      ? ((JSON.parse(compacted.detail) as { count?: number }).count ?? 0)
      : 0,
  }
}

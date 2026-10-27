import type { DatabaseSync } from 'node:sqlite'
import { bumpAdmission } from './ops.ts'
import { addHistory, type OrchRow } from './store.ts'

/** Deletes what the run's attempts left outside the orchestration tables: replies, runs, tool rows and intents. */
function pruneAssociated(tx: DatabaseSync, o: OrchRow): void {
  // By identity, not by the attempt's own turn id: a coding worker's every dispatch generation has a turn of its own
  // (7.7b §11). The launch projections and their journal tombstones stay: they are never pruned.
  const turns = [
    ...(
      tx.prepare('SELECT turn_id FROM orc_attempts WHERE orchestration_id = ?').all(o.id) as {
        turn_id: string
      }[]
    ).map((r) => r.turn_id),
    ...(
      tx
        .prepare(
          'SELECT turn_id FROM orc_generations WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
        )
        .all(o.id) as { turn_id: string }[]
    ).map((r) => r.turn_id),
  ]
  tx.prepare(
    'DELETE FROM wf_results WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
  ).run(o.id)
  tx.prepare(
    'DELETE FROM message_runs WHERE orchestration_attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
  ).run(o.id)
  for (const turn of turns) {
    const runs = tx.prepare('SELECT id FROM runs WHERE score_turn_id = ?').all(turn) as {
      id: string
    }[]
    for (const run of runs) {
      tx.prepare('DELETE FROM coding_run_results WHERE run_id = ?').run(run.id)
      tx.prepare('DELETE FROM coding_refusals WHERE run_id = ?').run(run.id)
      tx.prepare('DELETE FROM tool_calls WHERE run_id = ?').run(run.id)
      tx.prepare('DELETE FROM run_thinking WHERE run_id = ?').run(run.id)
      tx.prepare('DELETE FROM runs WHERE id = ?').run(run.id)
    }
    tx.prepare('DELETE FROM command_intents WHERE idempotency_key = ?').run(turn)
  }
  // Only what the run's attempts wrote: their reply rows and the lead's notes. Anything the person or another
  // process added to the room after it was released stays, with whatever refers to it.
  for (const attempt of tx
    .prepare('SELECT id, message_id FROM orc_attempts WHERE orchestration_id = ?')
    .all(o.id) as { id: string; message_id: string }[]) {
    // A reply or note that something outside the run now hangs on (a later room summary) stays, with its references:
    // it is ordinary room data from here on, and deleting it would break the foreign key and block maintenance.
    const referenced = tx.prepare(
      `SELECT 1 FROM message_runs WHERE (chain_id = ?1 OR parent_message_id = ?1)
         AND (orchestration_attempt_id IS NULL OR orchestration_attempt_id NOT IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?2)) LIMIT 1`,
    )
    const drop = (messageId: string) => {
      if (referenced.get(messageId, o.id) === undefined) {
        // A pinned decision goes with its message (PLAN 11.2).
        tx.prepare('DELETE FROM room_pins WHERE room_id = ? AND message_id = ?').run(
          o.room_id,
          messageId,
        )
        tx.prepare('DELETE FROM messages WHERE room_id = ? AND id = ?').run(o.room_id, messageId)
      }
    }
    drop(attempt.message_id)
    // Every dispatch generation streamed into a reply of its own.
    for (const generation of tx
      .prepare('SELECT message_id FROM orc_generations WHERE attempt_id = ?')
      .all(attempt.id) as { message_id: string }[])
      drop(generation.message_id)
    const notes = tx
      .prepare("SELECT id FROM messages WHERE room_id = ? AND id LIKE ? ESCAPE '\\'")
      .all(o.room_id, `orc-note:${attempt.id.replace(/[\\%_]/g, '\\$&')}:%`) as { id: string }[]
    for (const note of notes) drop(note.id)
  }
}

/**
 * Deletes a finished, released run's records (v8.1 item 5): everything it left outside and inside the orchestration
 * tables, in the caller's transaction. The room and its goal message stay unless the caller removes them; the single
 * `pruned` history row is the tombstone restore checks use.
 */
export function pruneOrchestrationRows(tx: DatabaseSync, o: OrchRow, nowIso: string): void {
  // The covered data goes together (v8.1 item 5): the charge is released only with every associated row. The
  // run's room and its goal message stay as the tombstone the brief hangs on.
  pruneAssociated(tx, o)
  for (const table of [
    'wf_consumed',
    'wf_commands',
    'wf_gates',
    'wf_tokens',
    'wf_steps',
    'wf_nodes',
    'wf_runs',
    'orc_agent_map',
    'orc_worker_policies',
    'orc_quota_holds',
    'orc_commands',
    'orc_causes',
    'orc_checks',
    'orc_gates',
    'orc_inquiries',
    'orc_steps',
  ])
    tx.prepare(`DELETE FROM ${table} WHERE orchestration_id = ?`).run(o.id)
  tx.prepare(
    'DELETE FROM orc_capabilities WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
  ).run(o.id)
  tx.prepare(
    'DELETE FROM orc_generations WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
  ).run(o.id)
  tx.prepare('DELETE FROM orc_attempts WHERE orchestration_id = ?').run(o.id)
  // The history goes with the rest; the single 'pruned' row added below is the tombstone restore checks use.
  tx.prepare('DELETE FROM orc_history WHERE orchestration_id = ?').run(o.id)
  tx.prepare('DELETE FROM orchestrations WHERE id = ?').run(o.id)
  addHistory(tx, o.id, 'pruned', { endedAt: o.ended_at, status: o.status }, nowIso)
  bumpAdmission(tx) // quota released by a pruned run can make waiting work admissible
}

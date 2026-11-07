import type { DatabaseSync } from 'node:sqlite'
import { applyClosure } from './coding-attempts.ts'
import { applyCodingEvidence } from './coding-checkpoint.ts'
import { insertAttemptRows } from './attempt-rows.ts'
import { journalDispatches, type JournalEntry } from './journal.ts'
import { recordRefusal, refuseAttempt, setStepStatus } from './ops.ts'
import { readAttempt, readOrch, readStep } from './store.ts'

/**
 * The journal is authoritative about what was sent. For every journaled `send_started` (or its tombstone) whose attempt
 * the database still shows as `created`, the attempt becomes `unknown` (never sent again), and a journaled handle is
 * attached so the Stop owed on it can be delivered. Lifting a fence never turns these back into sendable work.
 */
export function applyJournalEvidence(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  now: string,
): number {
  let changed = 0
  for (const [attemptId, latest] of journalDispatches(entries)) {
    const attempt = sqlite
      .prepare(
        'SELECT id, turn_id, state, step_id, orchestration_id, dispatch_generation, refused_generation, refused_total, refused_streak, runtime FROM orc_attempts WHERE id = ?',
      )
      .get(attemptId) as
      | {
          id: string
          turn_id: string
          state: string
          step_id: string | null
          orchestration_id: string
          dispatch_generation: number
          refused_generation: number
          refused_total: number
          refused_streak: number
          runtime: string
        }
      | undefined
    // A refusal the journal proved but the database lost, with the attempt still `send_started` at that very generation:
    // it was never sent. It goes back to `created` with the refusal counted (and the lifetime limit honoured).
    if (
      attempt &&
      attempt.state === 'send_started' &&
      latest.state === 'refused' &&
      latest.generation > 0 &&
      attempt.dispatch_generation === latest.generation &&
      attempt.refused_generation < latest.generation
    ) {
      const planner =
        (
          sqlite
            .prepare('SELECT planner FROM orchestrations WHERE id = ?')
            .get(attempt.orchestration_id) as { planner: 'lead' | 'workflow' } | undefined
        )?.planner ?? 'lead'
      recordRefusal(
        sqlite,
        { id: attempt.orchestration_id, planner },
        attempt,
        latest.generation,
        now,
      )
      changed++
      continue
    }
    // Generation g was proven to have launched nothing (7.7b §6) but the database never committed the closure: finish it,
    // with the refusal counters untouched. A closure never revives an attempt that is already past that generation.
    if (latest.state === 'closed' && attempt && latest.generation > 0) {
      const closedCause = (
        sqlite
          .prepare(
            'SELECT closed_cause FROM orc_generations WHERE attempt_id = ? AND generation = ?',
          )
          .get(attempt.id, latest.generation) as { closed_cause: string | null } | undefined
      )?.closed_cause
      if (closedCause === null && ['send_started', 'running'].includes(attempt.state)) {
        const cause = entries.findLast(
          (e) =>
            e.kind === 'send_closed' &&
            e.attemptId === attempt.id &&
            e.generation === latest.generation,
        ) as { cause: string } | undefined
        if (cause) {
          applyClosure(
            sqlite,
            { id: attempt.orchestration_id },
            attempt,
            latest.generation,
            cause.cause,
            now,
          )
          changed++
          continue
        }
      }
    }
    if (!attempt || attempt.state !== 'created') continue
    if (latest.state === 'closed' || latest.state === 'refused') {
      // Proven unsent: it stays sendable, but the generation counter never goes back (a restored database lagged).
      if (attempt.dispatch_generation < latest.generation) {
        sqlite
          .prepare('UPDATE orc_attempts SET dispatch_generation = ? WHERE id = ?')
          .run(latest.generation, attempt.id)
        changed++
      }
      continue
    }
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'journal_records_send', sent_at = COALESCE(sent_at, ?), dispatch_generation = MAX(dispatch_generation, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, latest.generation, now, attempt.id)
    if (attempt.step_id)
      sqlite
        .prepare(
          "UPDATE orc_steps SET status = 'unknown', disposition = 'journal_records_send', updated_at = ? WHERE orchestration_id = ? AND id = ? AND status = 'admitted'",
        )
        .run(now, attempt.orchestration_id, attempt.step_id)
    changed++
  }
  for (const entry of entries) {
    if (entry.kind !== 'run_handle') continue
    if (entry.generation !== undefined) {
      // A coding generation's handle is kept on its generation row, and attached to the attempt only while that
      // generation is the current, still open one: an older generation's run is never reattached.
      changed += Number(
        sqlite
          .prepare(
            'UPDATE orc_generations SET run_id = ? WHERE attempt_id = ? AND generation = ? AND run_id IS NULL',
          )
          .run(entry.runId, entry.attemptId, entry.generation).changes,
      )
      changed += Number(
        sqlite
          .prepare(
            `UPDATE orc_attempts SET run_id = ?, updated_at = ?
             WHERE id = ? AND run_id IS NULL AND dispatch_generation = ? AND state IN ('send_started', 'running', 'unknown')
               AND NOT EXISTS (SELECT 1 FROM orc_generations g WHERE g.attempt_id = orc_attempts.id AND g.generation = ? AND g.closed_cause IS NOT NULL)`,
          )
          .run(entry.runId, now, entry.attemptId, entry.generation, entry.generation).changes,
      )
      continue
    }
    const result = sqlite
      .prepare('UPDATE orc_attempts SET run_id = ?, updated_at = ? WHERE id = ? AND run_id IS NULL')
      .run(entry.runId, now, entry.attemptId)
    changed += Number(result.changes)
  }
  changed += applyRenewals(sqlite, entries, now)
  changed += applyCodingEvidence(sqlite, entries, now)
  return changed
}

/**
 * 7.7c F2 #1: replays the newest journaled Try again (dispatch renewal) of each coding node. The node's renewal count never
 * goes below the journal's, and a restored predecessor (proven unsent when the renewal was recorded) is retired and its input
 * and reservation move to the journaled successor, which waits suspended: the node shows "held back" again, and its next Try
 * again is counted.
 */
function applyRenewals(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  now: string,
): number {
  const newest = new Map<string, Extract<JournalEntry, { kind: 'renewal' }>>()
  for (const entry of entries)
    if (entry.kind === 'renewal') newest.set(`${entry.orchestrationId}:${entry.nodeId}`, entry)
  let changed = 0
  for (const entry of newest.values()) {
    const node = sqlite
      .prepare('SELECT renewals, step_id FROM wf_nodes WHERE orchestration_id = ? AND node_id = ?')
      .get(entry.orchestrationId, entry.nodeId) as
      { renewals: number; step_id: string | null } | undefined
    const o = readOrch(sqlite, entry.orchestrationId)
    if (!node || !o) continue
    const predecessor = readAttempt(sqlite, entry.predecessorId)
    if (
      predecessor &&
      predecessor.state === 'created' &&
      node.step_id !== null &&
      predecessor.step_id === node.step_id &&
      !readAttempt(sqlite, entry.successorId) &&
      readStep(sqlite, o.id, node.step_id)
    ) {
      refuseAttempt(sqlite, predecessor, 'not dispatched: renewed', now)
      sqlite
        .prepare(
          "UPDATE orc_attempts SET reserved_usd = 0, input = '', suspended = 0, updated_at = ? WHERE id = ?",
        )
        .run(now, predecessor.id)
      const n = (
        sqlite
          .prepare(
            'SELECT COUNT(*) AS c FROM orc_attempts WHERE orchestration_id = ? AND step_id = ?',
          )
          .get(o.id, node.step_id) as { c: number }
      ).c
      insertAttemptRows({ sqlite, now }, o, {
        id: entry.successorId,
        kind: 'step',
        stepId: node.step_id,
        n: n + 1,
        agentId: predecessor.agent_id,
        incarnation: predecessor.agent_incarnation,
        input: predecessor.input,
        reserved: predecessor.reserved_usd,
        claim: null,
        suspended: true,
        policyId: predecessor.policy_id,
      })
      setStepStatus(sqlite, o.id, node.step_id, 'blocked', 'held_back', now)
      changed++
    }
    if (node.renewals < entry.renewals) {
      sqlite
        .prepare(
          'UPDATE wf_nodes SET renewals = ?, revision = revision + 1 WHERE orchestration_id = ? AND node_id = ?',
        )
        .run(entry.renewals, entry.orchestrationId, entry.nodeId)
      changed++
    }
  }
  return changed
}

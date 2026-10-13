import type { DatabaseSync } from 'node:sqlite'
import { type FenceItem, type GlobalFence } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import { applyClosure } from './coding-attempts.ts'
import { recordRefusal } from './ops.ts'
import { applyCodingEvidence, verifyCoding } from './coding-checkpoint.ts'
import { foldCodingLaunches } from './coding-records.ts'
import {
  foldHistory,
  historyHold,
  journalDispatches,
  type ExecutionJournal,
  type JournalEntry,
  type LaunchFolder,
} from './journal.ts'

// The persistent global admission fence (design v3). It is set when the journal and the database disagree, when the
// journal is unreadable or missing, or when the operator restored a backup; only a recorded human decision lifts it.

const GlobalRowSchema = z.object({
  fenced: z.int(),
  reason: z.string().nullable(),
  fence_seq: z.int(),
  untrusted_history: z.int(),
  revision: z.int(),
  since: z.string().nullable(),
})
const ItemRowSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  journal_n: z.int().nullable(),
  detail: z.string(),
})

export interface Mismatch {
  kind: FenceItem['kind']
  ref: string
  journalN: number | null
  detail: string
  /** The database holds more than the journal does: the journal lost records (a truncated or replaced file). */
  lost?: boolean
}

export function readGlobal(sqlite: DatabaseSync) {
  return GlobalRowSchema.parse(sqlite.prepare('SELECT * FROM orc_global WHERE id = 1').get())
}

export function isFenced(sqlite: DatabaseSync): boolean {
  return readGlobal(sqlite).fenced === 1
}

/** Entries the person accepted as reconciled when they lifted an earlier fence. */
function acceptedSet(entries: readonly JournalEntry[]): Set<number> {
  const accepted = new Set<number>()
  for (const entry of entries)
    if (entry.kind === 'global_fence' && entry.action === 'lift')
      for (const n of entry.accepted ?? []) accepted.add(n)
  return accepted
}

/** Journal entries missing from, or newer than, the database. Pure read. */
export function verifyJournal(sqlite: DatabaseSync, entries: readonly JournalEntry[]): Mismatch[] {
  const accepted = acceptedSet(entries)
  const mismatches: Mismatch[] = []
  const attempt = sqlite.prepare(
    'SELECT state, run_id, sent_at, abandoned_at, dispatch_generation, refused_generation FROM orc_attempts WHERE id = ?',
  )
  const orchestration = sqlite.prepare(
    'SELECT stop_requested_at, finish_requested_at, waiver_at, status, manual_paused_at FROM orchestrations WHERE id = ?',
  )
  const attemptStop = sqlite.prepare('SELECT stop_requested_at FROM orc_attempts WHERE id = ?')
  const pruned = new Set(
    (
      sqlite
        .prepare("SELECT orchestration_id AS id FROM orc_history WHERE kind = 'pruned'")
        .all() as {
        id: string
      }[]
    ).map((row) => row.id),
  )
  const dbSeq = readGlobal(sqlite).fence_seq
  let journalSeq = 0
  // The last pause/resume per orchestration decides whether the journal expects a pause.
  const lastPauseState = new Map<string, { what: 'pause' | 'resume'; n: number }>()
  for (const entry of entries) {
    if (
      (entry.kind === 'transition' || (entry.kind === 'tombstone' && entry.of === 'transition')) &&
      (entry.what === 'pause' || entry.what === 'resume')
    )
      lastPauseState.set(entry.orchestrationId, { what: entry.what, n: entry.n })
  }
  // The newest authorization per orchestration and the newest hold per target say what the database must at least hold.
  const authorization = new Map<string, Extract<JournalEntry, { kind: 'authorization' }>>()
  const hold = new Map<string, Extract<JournalEntry, { kind: 'hold' }>>()
  for (const entry of entries) {
    if (entry.kind === 'authorization') authorization.set(entry.orchestrationId, entry)
    if (entry.kind === 'hold')
      hold.set(entry.target === 'team' ? 'team' : `agent:${entry.agentId}`, entry)
  }
  const remap = new Map<string, Extract<JournalEntry, { kind: 'remap' }>>()
  for (const entry of entries)
    if (entry.kind === 'remap') remap.set(`${entry.orchestrationId}:${entry.agentId}`, entry)
  // 7.7b: the newest settings a coding worker was remapped to (a database restored from before it would run the old ones).
  const policyRemap = new Map<string, Extract<JournalEntry, { kind: 'policy_remap' }>>()
  for (const entry of entries)
    if (entry.kind === 'policy_remap')
      policyRemap.set(`${entry.orchestrationId}:${entry.agentId}`, entry)
  const limits = sqlite.prepare(
    'SELECT budget_usd, deadline_at, accepted_unknown_spend, coding_steps, accepted_unknown_cost FROM orchestrations WHERE id = ?',
  )
  // v8.2 / v8.3: only the newest word on an attempt's dispatch counts; older generations are history.
  const dispatches = journalDispatches(entries)
  for (const entry of entries) {
    if (entry.kind === 'global_fence') journalSeq = Math.max(journalSeq, entry.fenceSeq)
    if (accepted.has(entry.n)) continue
    const orchestrationId =
      'orchestrationId' in entry ? (entry.orchestrationId as string) : undefined
    if (orchestrationId && pruned.has(orchestrationId)) continue
    const kind = entry.kind === 'tombstone' ? entry.of : entry.kind
    if (entry.kind === 'authorization') {
      if (authorization.get(entry.orchestrationId) !== entry) continue
      const row = limits.get(entry.orchestrationId) as
        | {
            budget_usd: number | null
            deadline_at: string | null
            accepted_unknown_spend: number
            coding_steps: number
            accepted_unknown_cost: string
          }
        | undefined
      const lost: string[] = []
      if (!row) lost.push('the run')
      else {
        if (
          entry.budgetUsd !== null &&
          (row.budget_usd === null || row.budget_usd > entry.budgetUsd)
        )
          lost.push('a lowered budget')
        if (
          entry.deadlineAt !== null &&
          (row.deadline_at === null || Date.parse(row.deadline_at) > Date.parse(entry.deadlineAt))
        )
          lost.push('a shorter deadline')
        if (!entry.acceptUnknownSpend && row.accepted_unknown_spend === 1)
          lost.push('a revoked unknown-spend acceptance')
        // 7.7b: a lowered coding step limit, or an unknown-cost acceptance taken back, that this database lacks.
        if (entry.codingSteps !== undefined && row.coding_steps > entry.codingSteps)
          lost.push('a lowered coding step limit')
        if (
          entry.acceptUnknownCost !== undefined &&
          (JSON.parse(row.accepted_unknown_cost) as string[]).some(
            (source) => !entry.acceptUnknownCost!.includes(source),
          )
        )
          lost.push('an unknown-cost acceptance that was taken back')
      }
      if (lost.length > 0)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The limits of ${entry.orchestrationId} were tightened (${lost.join(', ')}), but the database does not hold that`,
        })
    } else if (entry.kind === 'remap') {
      if (remap.get(`${entry.orchestrationId}:${entry.agentId}`) !== entry) continue
      const row = sqlite
        .prepare(
          'SELECT incarnation FROM orc_agent_map WHERE orchestration_id = ? AND agent_id = ?',
        )
        .get(entry.orchestrationId, entry.agentId) as { incarnation: string } | undefined
      if (!row || row.incarnation !== entry.incarnation)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The remap of ${entry.agentId} in ${entry.orchestrationId} was recorded, but the database does not hold it`,
        })
    } else if (entry.kind === 'policy_remap') {
      if (policyRemap.get(`${entry.orchestrationId}:${entry.agentId}`) !== entry) continue
      const row = sqlite
        .prepare(
          'SELECT policy_id FROM orc_worker_policies WHERE orchestration_id = ? AND agent_id = ?',
        )
        .get(entry.orchestrationId, entry.agentId) as { policy_id: string } | undefined
      if (!row || row.policy_id !== entry.policyId)
        mismatches.push({
          kind: 'fence',
          ref: entry.orchestrationId,
          journalN: entry.n,
          detail: `The new settings for ${entry.agentId} in ${entry.orchestrationId} were approved, but the database does not hold them`,
        })
    } else if (entry.kind === 'hold') {
      const key = entry.target === 'team' ? 'team' : `agent:${entry.agentId}`
      if (hold.get(key) !== entry || entry.action !== 'set') continue
      const held =
        entry.target === 'team'
          ? sqlite.prepare('SELECT 1 FROM team_state WHERE id = 1 AND paused_at IS NOT NULL').get()
          : sqlite.prepare('SELECT 1 FROM agent_pauses WHERE agent_id = ?').get(entry.agentId ?? '')
      if (!held)
        mismatches.push({
          kind: 'fence',
          ref: key,
          journalN: entry.n,
          detail: `The pause of ${entry.target === 'team' ? 'the team' : `agent ${entry.agentId}`} was recorded, but the database does not hold it`,
        })
    } else if (
      kind === 'send_started' ||
      entry.kind === 'send_refused' ||
      entry.kind === 'send_closed' ||
      entry.kind === 'witness'
    ) {
      const id = (entry as { attemptId: string }).attemptId
      const latest = dispatches.get(id)
      if (!latest || latest.n !== entry.n) continue
      const row = attempt.get(id) as
        | { sent_at: string | null; dispatch_generation: number; refused_generation: number }
        | undefined
      if (!row || (latest.state === 'sent' && row.sent_at === null))
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `Admission of attempt ${id} was started, but the database has no record of it`,
        })
      else if (
        latest.state === 'refused' &&
        latest.generation > 0 &&
        row.refused_generation < latest.generation
      )
        // The journal proves generation g was refused, but the database never committed that refusal (a crash between
        // the two): its state at g may still read "sent".
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records a refusal of dispatch generation ${latest.generation} of attempt ${id}, but the database does not hold it`,
        })
      else if (
        latest.state === 'closed' &&
        latest.generation > 0 &&
        (
          sqlite
            .prepare(
              'SELECT closed_cause FROM orc_generations WHERE attempt_id = ? AND generation = ?',
            )
            .get(id, latest.generation) as { closed_cause: string | null } | undefined
        )?.closed_cause === null
      )
        // The journal proves generation g launched nothing and was closed; the database never committed that.
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records dispatch generation ${latest.generation} of attempt ${id} as closed, but the database does not hold it`,
        })
      else if (latest.generation > 0 && row.dispatch_generation < latest.generation)
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `The journal records dispatch generation ${latest.generation} of attempt ${id} (${latest.state === 'sent' ? 'sent' : 'refused'}), but the database is behind it`,
        })
    } else if (entry.kind === 'run_handle') {
      const row = attempt.get(entry.attemptId) as
        { run_id: string | null; dispatch_generation: number } | undefined
      // Only the latest admitted generation's handle is verified; older ones are evidence (7.7b §5). A generation's own
      // handle lives on its generation row (the attempt's run_id is cleared when that generation is closed).
      if (entry.generation !== undefined) {
        if (row && entry.generation < row.dispatch_generation) continue
        const held = sqlite
          .prepare('SELECT run_id FROM orc_generations WHERE attempt_id = ? AND generation = ?')
          .get(entry.attemptId, entry.generation) as { run_id: string | null } | undefined
        if (!held || held.run_id !== entry.runId)
          mismatches.push({
            kind: 'handle',
            ref: entry.attemptId,
            journalN: entry.n,
            detail: `Run ${entry.runId} was returned for generation ${entry.generation} of attempt ${entry.attemptId}, but the database does not hold that handle`,
          })
        continue
      }
      if (!row || row.run_id !== entry.runId)
        mismatches.push({
          kind: 'handle',
          ref: entry.attemptId,
          journalN: entry.n,
          detail: `Hermes run ${entry.runId} was returned for attempt ${entry.attemptId}, but the database does not hold that handle`,
        })
    } else if (kind === 'stop_fence') {
      const e = entry as { orchestrationId: string; attemptId?: string }
      const row = (
        e.attemptId === undefined
          ? orchestration.get(e.orchestrationId)
          : attemptStop.get(e.attemptId)
      ) as { stop_requested_at: string | null } | undefined
      if (!row || row.stop_requested_at === null)
        mismatches.push({
          kind: 'fence',
          ref: e.attemptId ?? e.orchestrationId,
          journalN: entry.n,
          detail: `Stop was requested for ${e.attemptId ?? e.orchestrationId}, but the database does not record it`,
        })
    } else if (kind === 'transition') {
      const e = entry as { orchestrationId: string; what: string; attemptIds?: string[]; n: number }
      const row = orchestration.get(e.orchestrationId) as
        | {
            finish_requested_at: string | null
            waiver_at: string | null
            status: string
            manual_paused_at: string | null
          }
        | undefined
      let missing = !row
      if (row && e.what === 'finish') missing = row.finish_requested_at === null
      if (row && e.what === 'waiver') missing = row.waiver_at === null
      if (row && e.what === 'pause')
        missing =
          lastPauseState.get(e.orchestrationId)?.what === 'pause' &&
          lastPauseState.get(e.orchestrationId)!.n === e.n &&
          row.manual_paused_at === null &&
          (row.status === 'running' || row.status === 'paused')
      if (row && e.what === 'abandon')
        missing = (e.attemptIds ?? []).some(
          (id) =>
            (attempt.get(id) as { abandoned_at: string | null } | undefined)?.abandoned_at == null,
        )
      if (e.what === 'resume') missing = false
      if (missing)
        mismatches.push({
          kind: 'fence',
          ref: e.orchestrationId,
          journalN: entry.n,
          detail: `The ${e.what} of ${e.orchestrationId} was recorded, but the database does not hold it`,
        })
    }
  }
  if (journalSeq > dbSeq) {
    const newest = entries.findLast(
      (entry) => entry.kind === 'global_fence' && entry.fenceSeq === journalSeq,
    )
    if (newest && !accepted.has(newest.n))
      mismatches.push({
        kind: 'fence',
        ref: 'global',
        journalN: newest.n,
        detail: 'A global fence change is newer than the database',
      })
  }
  // 7.7a §2: coding launches and the database's checkpoint sequence.
  mismatches.push(...verifyCoding(sqlite, entries, accepted))
  return mismatches
}

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
        'SELECT id, turn_id, state, step_id, orchestration_id, dispatch_generation, refused_generation, refused_total, refused_streak FROM orc_attempts WHERE id = ?',
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
  changed += applyCodingEvidence(sqlite, entries, now)
  return changed
}

/**
 * Orchestration-only loss (decision 72): every attempt the database says was dispatched has a `send_started` record (or
 * the tombstone compaction leaves) in the journal. One without it means the journal lost a witness (a truncated or
 * replaced file) even when no coding state is involved. Attempts of an archived history (created before the newest
 * reset, or retired by it) are exempt: their witnesses are in the archive.
 */
export function unjournaledAttempts(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  scope: string,
): Mismatch[] {
  const known = journalDispatches(entries.filter((entry) => entry.scope === scope))
  const resetAt = foldHistory(entries, scope).resetAt
  const rows = sqlite
    .prepare(
      `SELECT id, created_at, dispatch_generation FROM orc_attempts WHERE dispatch_generation > 0 AND unknown_reason IS NOT 'history_reset'`,
    )
    .all() as { id: string; created_at: string; dispatch_generation: number }[]
  // The journal is written before the database commits a dispatch, so it can never hold an older generation of an
  // attempt than the database does: a surviving older word (a refusal, an earlier send) is a truncated journal, not a
  // match (re-review 6 #7). A generation of 0 is a tombstone that kept no number.
  const lostWitness = (row: { id: string; dispatch_generation: number }): boolean => {
    const witness = known.get(row.id)
    return !witness || (witness.generation > 0 && witness.generation < row.dispatch_generation)
  }
  return rows
    .filter((row) => lostWitness(row) && (resetAt === null || row.created_at >= resetAt))
    .slice(0, 20)
    .map((row) => ({
      kind: 'attempt' as const,
      ref: row.id,
      journalN: null,
      lost: true,
      detail: `The database dispatched attempt ${row.id}, but the journal has no record of that: the journal lost a witness`,
    }))
}

/**
 * Launch folders that hold receipts the journal has no launch for: evidence this installation can't account for (the
 * journal lost a witness). No lift, time or earlier decision accounts for them; only `reset-history` does.
 */
export function unownedLaunchFolders(
  entries: readonly JournalEntry[],
  folders: readonly LaunchFolder[],
): Mismatch[] {
  const known = foldCodingLaunches(entries)
  return folders
    .filter((folder) => !known.has(folder.id))
    .map(({ id }) => ({
      kind: 'journal' as const,
      ref: `launch-folder:${id}`,
      journalN: null,
      lost: true,
      detail: `A launch folder (${id}) holds receipts, but the journal has no coding launch with that id: the journal lost a witness`,
    }))
}

export function fenceItems(sqlite: DatabaseSync): FenceItem[] {
  const seq = readGlobal(sqlite).fence_seq
  return z
    .array(ItemRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT kind, ref, journal_n, detail FROM orc_fence_items WHERE fence_seq = ? ORDER BY id',
        )
        .all(seq),
    )
    .map((row) => ({
      kind: z
        .enum(['attempt', 'handle', 'fence', 'journal', 'restore'])
        .catch('journal')
        .parse(row.kind),
      ref: row.ref,
      detail: row.detail,
    }))
}

export function fenceView(sqlite: DatabaseSync, journal: ExecutionJournal): GlobalFence {
  const row = readGlobal(sqlite)
  const read = journal.readOwn()
  return {
    fenced: row.fenced === 1,
    reason: row.reason,
    untrustedHistory: row.untrusted_history === 1,
    revision: row.revision,
    since: row.since,
    items: row.fenced === 1 ? fenceItems(sqlite) : [],
    journal: {
      ok: read.ok,
      entries: read.ok ? read.entries.length : 0,
      bytes: read.bytes,
      sizeAlarm: journal.sizeAlarm(),
    },
  }
}

/**
 * What the person reads (fence screen, coding card) while Score holds all agent work. A frozen state is only left with
 * `scripts/score installation reset-history`; an unresolved installation says what to do about the installation instead.
 */
export function holdingNotice(why: string, resettable = true): string {
  const reason = why.trim().replace(/[.]$/, '')
  return `Score is holding all agent work: ${reason}.${resettable ? ' Run scripts/score installation reset-history to continue.' : ''}`
}

/** The fence item that carries the freeze (the web fence screen shows its sentence and no lift button). */
export const FROZEN_REF = 'execution-frozen'

export class GlobalFenceStore {
  /** Set when the installation identity is unresolved (copied home, ambiguity, corrupt registry): no admission, and
   * the person cannot lift the fence until they have resolved it (`score installation confirm-move|confirm-copy`). */
  private hardBlock: string | null = null

  setHardBlock(message: string | null): void {
    this.hardBlock = message
  }

  /** The installation registry says this home is a copy of another installation (until its history is reset). */
  /** Set once the journal file has been seen: its later absence is a loss, never a fresh namespace. */
  private journalSeen = false
  private lostHistory: string | null = null
  private lostPersisted = false

  private copiedFrom: string | undefined
  setCopiedFrom(id: string | undefined): void {
    this.copiedFrom = id
  }

  /**
   * FV (decision 71): why Score holds all agent work, or null. One predicate for the executor, Hermes intent recovery,
   * the coding runtime and the unit backend: while it is non-null nothing is dispatched, no Stop is delivered, no
   * recovery signals anything. Unresolved installation is derived; the persisted states (a copied home, a lost or
   * truncated execution journal) are left only by `reset-history`.
   */
  executionFrozen(): string | null {
    if (this.hardBlock !== null) return this.hardBlock
    // Callers ask from inside their own transactions too (the bridge lease, verification #1): answer on that one.
    const inTx = this.db.sqlite.isTransaction
    const why = inTx
      ? this.executionFrozenIn(this.db.sqlite)
      : this.db.read((sqlite) => this.executionFrozenIn(sqlite))
    // A journal that vanished is remembered for good (latched in memory at once, persisted at the first chance outside a
    // transaction), so recreating the file can't thaw it.
    if (this.lostHistory !== null && !this.lostPersisted && !inTx) {
      try {
        this.freeze(this.lostHistory)
        this.lostPersisted = true
      } catch {
        // the in-memory latch keeps answering
      }
    }
    return why
  }

  /**
   * The same, inside a transaction the caller already holds. Sticky (decision 72): the database says so, OR the journal's
   * newest freeze record is not superseded by a completed reset, OR the journal can't be read at all. A restored older
   * database therefore can't forget a freeze the journal remembers.
   */
  executionFrozenIn(sqlite: DatabaseSync): string | null {
    if (this.hardBlock !== null) return this.hardBlock
    const stored =
      (
        sqlite.prepare('SELECT frozen_reason FROM orc_global WHERE id = 1').get() as
          { frozen_reason: string | null } | undefined
      )?.frozen_reason ?? null
    if (stored !== null) return stored
    if (this.lostHistory !== null) return this.lostHistory
    // An established journal that disappears while Score runs is history lost, not a fresh start (re-review 6 #7).
    // Checked here so it precedes every dispatch decision and append that asks the predicate.
    if (this.journal.isFresh()) {
      if (this.journalSeen)
        return (this.lostHistory = 'the execution journal disappeared while Score was running')
    } else this.journalSeen = true
    const history = this.journal.historyState()
    if (!history.ok) return `the execution journal cannot be read (${history.reason})`
    return historyHold(history)
  }

  /** `executionFrozen()` as the sentence the person reads, or null. */
  frozenNotice(): string | null {
    const why = this.executionFrozen()
    return why === null ? null : holdingNotice(why, this.hardBlock === null)
  }

  /** Persists the freeze (the first reason stays) and raises the fence with the sentence as its only way forward. */
  freeze(why: string): void {
    // The durable evidence outside the database first; the database flag below stands on its own if the journal can't
    // take the record. Once per freeze: a later start finds the earlier record.
    try {
      const history = this.journal.historyState()
      // A journal that vanished reads as not ok, yet takes this one record (verification #5); a damaged one refuses it.
      if (!history.ok || historyHold(history) === null)
        this.journal.append({ kind: 'execution-freeze', reason: why.slice(0, 1000) })
    } catch {
      // unreadable or unwritable: executionFrozen() treats an unreadable journal as frozen anyway
    }
    this.db.tx((sqlite) =>
      sqlite
        .prepare('UPDATE orc_global SET frozen_reason = COALESCE(frozen_reason, ?) WHERE id = 1')
        .run(why),
    )
    this.set(
      'execution_frozen',
      [{ kind: 'journal', ref: FROZEN_REF, journalN: null, detail: holdingNotice(why) }],
      { untrustedHistory: true },
    )
  }

  constructor(
    private readonly db: ScoreDb,
    readonly journal: ExecutionJournal,
    private readonly clock: () => number = Date.now,
    /** Announces a change (the executor emits `orchestration.fence.updated`). */
    public onChange: () => void = () => undefined,
  ) {}

  view(): GlobalFence {
    return this.db.read((sqlite) => fenceView(sqlite, this.journal))
  }

  /**
   * Sets the fence. The journal entry comes first (fsync'd), then the database: a crash between leaves the journal
   * ahead of the database, which the next start turns into a fence anyway.
   */
  set(reason: string, items: Mismatch[], options: { untrustedHistory?: boolean } = {}): void {
    const current = this.db.read((sqlite) => readGlobal(sqlite))
    const fenceSeq = this.nextSeq(current.fence_seq)
    // A fence that is already up keeps its number: only new doubts are added to its list.
    // Fail closed: the fence is the safety, so a journal that cannot record it must not stop the database from holding it.
    if (current.fenced !== 1 && this.journalUsable()) {
      try {
        this.journal.append({ kind: 'global_fence', action: 'set', fenceSeq, reason })
      } catch {
        // The database fence below stands on its own.
      }
    }
    const now = new Date(this.clock()).toISOString()
    this.db.tx((sqlite) => {
      const row = readGlobal(sqlite)
      // Already fenced: keep the earlier reason and fence number, add the new doubts.
      const seq = row.fenced === 1 ? row.fence_seq : fenceSeq
      if (row.fenced !== 1)
        sqlite
          .prepare(
            `UPDATE orc_global SET fenced = 1, reason = ?, fence_seq = ?, since = ?, revision = revision + 1,
             untrusted_history = MAX(untrusted_history, ?) WHERE id = 1`,
          )
          .run(reason, seq, now, options.untrustedHistory ? 1 : 0)
      else if (options.untrustedHistory)
        sqlite
          .prepare(
            'UPDATE orc_global SET untrusted_history = 1, revision = revision + 1 WHERE id = 1',
          )
          .run()
      // A fence that is still up sees the same doubts again on every start: list each once.
      const insert = sqlite.prepare(
        `INSERT INTO orc_fence_items (fence_seq, kind, ref, journal_n, detail) SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM orc_fence_items WHERE fence_seq = ?1 AND kind = ?2 AND ref = ?3 AND journal_n IS ?4)`,
      )
      for (const item of items) insert.run(seq, item.kind, item.ref, item.journalN, item.detail)
      sqlite
        .prepare(
          'INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (NULL, ?, ?, ?)',
        )
        .run('global_fence_set', JSON.stringify({ reason, items: items.length }), now)
    })
    this.onChange()
  }

  /** The human decision: records it, journals the accepted entries and lifts the fence. */
  lift(expectedRevision: number, note: string | undefined): void {
    const current = this.db.read((sqlite) => readGlobal(sqlite))
    if (current.revision !== expectedRevision)
      throw new HttpError(
        409,
        'conflict',
        'The list changed while you were looking. Reload it and try again.',
      )
    if (current.fenced !== 1)
      throw new HttpError(409, 'conflict', 'Nothing is blocked, so there is nothing to unblock.')
    const frozen = this.frozenNotice()
    if (frozen !== null) throw new HttpError(409, 'fenced', frozen)
    const accepted = this.db
      .read((sqlite) =>
        z
          .array(z.object({ journal_n: z.int().nullable() }))
          .parse(
            sqlite
              .prepare('SELECT journal_n FROM orc_fence_items WHERE fence_seq = ?')
              .all(current.fence_seq),
          ),
      )
      .flatMap((row) => (row.journal_n === null ? [] : [row.journal_n]))
    const fenceSeq = this.nextSeq(current.fence_seq)
    // A journal that cannot be written must not be "lifted" past: the next effect could not be recorded.
    if (!this.journalUsable())
      throw new HttpError(
        409,
        'fenced',
        'Score can’t read its record of runs. Restore a backup or repair it first.',
      )
    this.journal.append({
      kind: 'global_fence',
      action: 'lift',
      fenceSeq,
      reason: note ?? 'lifted by the person',
      accepted,
    })
    const now = new Date(this.clock()).toISOString()
    const own = this.journal.readOwn()
    this.db.tx((sqlite) => {
      if (own.ok) applyJournalEvidence(sqlite, own.entries, now)
      sqlite
        .prepare(
          `UPDATE orc_global SET fenced = 0, fence_seq = ?, lifted_at = ?, revision = revision + 1, admission_revision = admission_revision + 1 WHERE id = 1`,
        )
        .run(fenceSeq, now)
      sqlite
        .prepare(
          'INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (NULL, ?, ?, ?)',
        )
        .run('global_fence_lifted', JSON.stringify({ note: note ?? null, accepted }), now)
    })
    this.onChange()
  }

  /** Fence numbers only grow: past the database's and past anything the journal remembers (a restored database lags). */
  private nextSeq(dbSeq: number): number {
    const read = this.journal.readOwn()
    const journalMax = read.ok
      ? read.entries.reduce(
          (max, entry) => (entry.kind === 'global_fence' ? Math.max(max, entry.fenceSeq) : max),
          0,
        )
      : 0
    return Math.max(dbSeq, journalMax) + 1
  }

  private journalUsable(): boolean {
    return this.journal.readOwn().ok
  }

  /**
   * Every start: compare the journal with the database. Returns true when the fence is (now) set.
   * Unreadable or missing history, an operator restore, or any entry the database lacks fences all admission.
   */
  startupCheck(): { fenced: boolean; reasons: string[] } {
    const reasons: string[] = []
    const alreadyFenced = this.db.read((sqlite) => isFenced(sqlite))
    if (this.hardBlock === null) this.liftResolvedInstallationBlock()
    if (this.hardBlock !== null) {
      reasons.push('installation_unresolved')
      this.set('installation_unresolved', [
        {
          kind: 'journal',
          ref: FROZEN_REF,
          journalN: null,
          detail: holdingNotice(this.hardBlock, false),
        },
      ])
    }
    const marker = this.journal.readRestoreMarker()
    const fresh = this.journal.isFresh()
    const opened = this.journal.open()
    this.checkHistoryGeneration(reasons)
    if (marker !== undefined) {
      reasons.push('restore')
      this.set(
        'restore',
        [
          {
            kind: 'restore',
            ref: marker === 'malformed' ? 'marker' : marker.backup,
            journalN: null,
            detail:
              marker === 'malformed'
                ? 'A restore marker exists but cannot be read; treat history as untrusted'
                : marker.origin === 'copy'
                  ? `This home is a copy of ${marker.backup}, confirmed at ${marker.at}; the run history it inherited is untrusted`
                  : `Score's home was restored from ${marker.backup} at ${marker.at}; execution history is untrusted`,
          },
        ],
        { untrustedHistory: true },
      )
      // A confirmed copy holds everything it inherited, and the marker is about to go: remember that for good.
      if (marker !== 'malformed' && marker.origin === 'copy')
        this.freeze(
          `this folder is a copy of ${marker.backup}, and what it inherited is not its own`,
        )
      this.journal.clearRestoreMarker()
    }
    if (!opened) {
      reasons.push('journal_unreadable')
      const read = this.journal.readOwn()
      this.set('journal_unreadable', [
        {
          kind: 'journal',
          ref: 'journal',
          journalN: null,
          detail: `The execution journal cannot be read (${read.ok ? 'unknown' : read.reason}); Score cannot tell whether history was lost`,
        },
      ])
    } else {
      const entries = this.journal.readOwn()
      // A copy (confirmed in the registry) holds all agent work until its history is reset, whatever happened to the
      // marker or the database since.
      if (
        this.copiedFrom !== undefined &&
        entries.ok &&
        !entries.entries.some((entry) => entry.kind === 'history-reset')
      ) {
        reasons.push('execution_frozen')
        this.freeze(
          `this folder is a copy of installation ${this.copiedFrom}, and what it inherited is not its own`,
        )
      }
      const lost = this.journal.missingHistory()
      const sqliteHasHistory = this.db.read(
        (sqlite) =>
          sqlite.prepare('SELECT 1 FROM orc_attempts WHERE sent_at IS NOT NULL LIMIT 1').get() !==
            undefined ||
          sqlite.prepare('SELECT 1 FROM coding_launches LIMIT 1').get() !== undefined,
      )
      if (fresh && (sqliteHasHistory || lost !== undefined)) {
        // The database remembers admissions (or the folder remembers its own history) but the journal is not there:
        // it was deleted or moved. A missing file is "fresh" only when nothing else says otherwise (FZ3 #13). Nothing
        // here can say what ran, so Score freezes until the person starts a new history.
        reasons.push('journal_missing')
        this.freeze(
          lost !== undefined
            ? `the execution journal does not exist, although ${lost}`
            : 'the database records admissions, but the execution journal does not exist',
        )
      } else if (entries.ok) {
        const now = new Date(this.clock()).toISOString()
        const mismatches = [
          ...this.db.read((sqlite) => verifyJournal(sqlite, entries.entries)),
          ...unownedLaunchFolders(entries.entries, this.journal.launchDirectories()),
          ...this.db.read((sqlite) =>
            unjournaledAttempts(sqlite, entries.entries, this.journal.scope),
          ),
        ]
        // The journal holds less than the database or the launch folders witnessed (truncated, replaced): nothing
        // automatic can say what ran, so this freezes too (decision 71).
        const lostRecords = mismatches.filter((item) => item.lost === true)
        if (lostRecords.length > 0) {
          reasons.push('journal_truncated')
          this.freeze(
            `the execution journal holds less than this installation witnessed (${lostRecords[0]!.detail})`,
          )
        }
        if (mismatches.length > 0) {
          reasons.push('journal_mismatch')
          this.set('journal_mismatch', mismatches)
          // What the journal says was sent is never sendable again, whatever happens to the fence.
          this.db.tx((sqlite) => applyJournalEvidence(sqlite, entries.entries, now))
        }
      }
    }
    const fenced = alreadyFenced || reasons.length > 0
    return { fenced, reasons }
  }

  /**
   * The journal and the database must name the same history (decision 72). A database that doesn't carry the generation
   * of the journal's completed reset predates it (a restored backup): its retired work would come back. A database that
   * names a generation the journal doesn't hold has lost its journal. Both freeze, durably.
   */
  private checkHistoryGeneration(reasons: string[]): void {
    const history = this.journal.historyState()
    if (!history.ok) return // executionFrozen() already reports an unreadable journal
    const stored = this.db.read(
      (sqlite) =>
        (
          sqlite.prepare('SELECT history_generation FROM orc_global WHERE id = 1').get() as
            { history_generation: string | null } | undefined
        )?.history_generation ?? null,
    )
    if (history.generation !== null && history.complete) {
      if (stored === history.generation) return
      // A database with no history of its own (brand new, or the reset ran before it existed) adopts the generation.
      if (stored === null && !this.databaseHoldsExecutionHistory()) {
        this.db.tx((sqlite) =>
          sqlite
            .prepare('UPDATE orc_global SET history_generation = ? WHERE id = 1')
            .run(history.generation),
        )
        return
      }
      reasons.push('history_generation_mismatch')
      this.freeze(
        'the database is not the one that was reset (it looks like a backup from before the history reset)',
      )
    } else if (history.generation === null && stored !== null) {
      reasons.push('history_generation_mismatch')
      this.freeze(
        'the database belongs to a history that was reset, but the execution journal does not hold that reset',
      )
    }
  }

  /**
   * Whether the database carries any execution state at all (re-review 6 #2): attempts, launches, intents, steps, chat
   * replies, runs or approval deliveries that are not provably over. Only a database with none of it is "brand new" and
   * may adopt the journal's reset generation; a backup that still holds executable work must freeze instead.
   */
  private databaseHoldsExecutionHistory(): boolean {
    const probes: [table: string, where: string][] = [
      ['orc_attempts', '1'],
      ['coding_launches', '1'],
      ['command_intents', '1'],
      ['orc_steps', "status IN ('pending_gate', 'queued', 'admitted')"],
      ['message_runs', "state IN ('pending', 'active')"],
      ['runs', "status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')"],
      ['approval_deliveries', '1'],
    ]
    return this.db.read((sqlite) =>
      probes.some(([table, where]) => {
        // A table an older schema doesn't have holds nothing.
        if (
          sqlite
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table) === undefined
        )
          return false
        return sqlite.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get() !== undefined
      }),
    )
  }

  /**
   * The fence an earlier start raised because the installation was unresolved is the only one the person's
   * `score installation confirm-*` already decided: once the identity resolves, nothing else holds it up.
   */
  private liftResolvedInstallationBlock(): void {
    const row = this.db.read((sqlite) => readGlobal(sqlite))
    if (row.fenced !== 1 || row.reason !== 'installation_unresolved') return
    if (this.executionFrozen() !== null) return
    const items = this.db.read((sqlite) => fenceItems(sqlite))
    if (items.some((item) => item.ref !== FROZEN_REF)) return
    this.lift(row.revision, 'the installation was confirmed')
  }

  /**
   * The journal root's provenance (kept outside the home) is missing, corrupt or never saw this home, yet the database
   * holds orchestration or workflow history: the journal that witnessed it may be elsewhere, so no executor work is
   * admitted until the operator reconciles. Returns true when the fence was raised.
   */
  fenceUnverifiedRoot(why: string): boolean {
    const hasHistory = this.db.read(
      (sqlite) =>
        sqlite.prepare('SELECT 1 FROM orchestrations LIMIT 1').get() !== undefined ||
        sqlite.prepare('SELECT 1 FROM wf_runs LIMIT 1').get() !== undefined,
    )
    if (!hasHistory) return false
    this.set(
      'journal_root_unverified',
      [
        {
          kind: 'journal',
          ref: 'journal-root',
          journalN: null,
          detail: `${why}. This database holds orchestration history but Score can't tell which execution journal witnessed it; confirm the journal folder holds this home's journal before lifting the fence`,
        },
      ],
      { untrustedHistory: true },
    )
    return true
  }
}

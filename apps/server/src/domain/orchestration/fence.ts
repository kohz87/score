import type { DatabaseSync } from 'node:sqlite'
import type { FenceItem, GlobalFence } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import type { ExecutionJournal, JournalEntry } from './journal.ts'

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
    'SELECT state, run_id, sent_at, abandoned_at FROM orc_attempts WHERE id = ?',
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
  const limits = sqlite.prepare(
    'SELECT budget_usd, deadline_at, accepted_unknown_spend FROM orchestrations WHERE id = ?',
  )
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
    } else if (kind === 'send_started') {
      const id = (entry as { attemptId: string }).attemptId
      const row = attempt.get(id) as { sent_at: string | null } | undefined
      if (!row || row.sent_at === null)
        mismatches.push({
          kind: 'attempt',
          ref: id,
          journalN: entry.n,
          detail: `Admission of attempt ${id} was started, but the database has no record of it`,
        })
    } else if (entry.kind === 'run_handle') {
      const row = attempt.get(entry.attemptId) as { run_id: string | null } | undefined
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
  for (const entry of entries) {
    const sent =
      entry.kind === 'send_started' || (entry.kind === 'tombstone' && entry.of === 'send_started')
    if (sent && 'attemptId' in entry && entry.attemptId) {
      const attempt = sqlite
        .prepare('SELECT id, state, step_id, orchestration_id FROM orc_attempts WHERE id = ?')
        .get(entry.attemptId) as
        { id: string; state: string; step_id: string | null; orchestration_id: string } | undefined
      if (attempt && attempt.state === 'created') {
        sqlite
          .prepare(
            "UPDATE orc_attempts SET state = 'unknown', unknown_reason = 'journal_records_send', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?",
          )
          .run(now, now, attempt.id)
        if (attempt.step_id)
          sqlite
            .prepare(
              "UPDATE orc_steps SET status = 'unknown', disposition = 'journal_records_send', updated_at = ? WHERE orchestration_id = ? AND id = ? AND status = 'admitted'",
            )
            .run(now, attempt.orchestration_id, attempt.step_id)
        changed++
      }
    } else if (entry.kind === 'run_handle') {
      const result = sqlite
        .prepare(
          'UPDATE orc_attempts SET run_id = ?, updated_at = ? WHERE id = ? AND run_id IS NULL',
        )
        .run(entry.runId, now, entry.attemptId)
      changed += Number(result.changes)
    }
  }
  return changed
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

export class GlobalFenceStore {
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
      throw new HttpError(409, 'conflict', 'The fence changed since you looked; reload the list')
    if (current.fenced !== 1) throw new HttpError(409, 'conflict', 'There is no fence to lift')
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
        'The execution journal is unreadable; restore or repair it first',
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
          `UPDATE orc_global SET fenced = 0, fence_seq = ?, lifted_at = ?, revision = revision + 1 WHERE id = 1`,
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
    const marker = this.journal.readRestoreMarker()
    const fresh = this.journal.isFresh()
    const opened = this.journal.open()
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
                : `Score's home was restored from ${marker.backup} at ${marker.at}; execution history is untrusted`,
          },
        ],
        { untrustedHistory: true },
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
      const sqliteHasHistory = this.db.read(
        (sqlite) =>
          sqlite.prepare('SELECT 1 FROM orc_attempts WHERE sent_at IS NOT NULL LIMIT 1').get() !==
          undefined,
      )
      if (fresh && sqliteHasHistory) {
        // The database remembers admissions but the journal has never existed here: it was deleted or moved.
        reasons.push('journal_missing')
        this.set('journal_missing', [
          {
            kind: 'journal',
            ref: 'journal',
            journalN: null,
            detail: 'The database records admissions, but the execution journal does not exist',
          },
        ])
      } else if (entries.ok) {
        const mismatches = this.db.read((sqlite) => verifyJournal(sqlite, entries.entries))
        if (mismatches.length > 0) {
          reasons.push('journal_mismatch')
          this.set('journal_mismatch', mismatches)
          // What the journal says was sent is never sendable again, whatever happens to the fence.
          const now = new Date(this.clock()).toISOString()
          this.db.tx((sqlite) => applyJournalEvidence(sqlite, entries.entries, now))
        }
      }
    }
    const fenced = alreadyFenced || reasons.length > 0
    return { fenced, reasons }
  }
}

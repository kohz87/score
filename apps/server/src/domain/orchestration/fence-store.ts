import type { DatabaseSync } from 'node:sqlite'
import type { GlobalFence } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { applyJournalEvidence } from './fence-evidence.ts'
import { FROZEN_REF, holdingNotice } from './fence-notice.ts'
import { fenceView, readGlobal } from './fence-read.ts'
import { GlobalFenceStartup } from './fence-startup.ts'
import type { Mismatch } from './fence-types.ts'
import { historyHold } from './journal.ts'

export class GlobalFenceStore extends GlobalFenceStartup {
  setHardBlock(message: string | null): void {
    this.hardBlock = message
  }

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
}

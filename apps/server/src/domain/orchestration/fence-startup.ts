import type { ScoreDb } from '../../db/index.ts'
import { applyJournalEvidence } from './fence-evidence.ts'
import { FROZEN_REF, holdingNotice } from './fence-notice.ts'
import { fenceItems, isFenced, readGlobal } from './fence-read.ts'
import type { Mismatch } from './fence-types.ts'
import { unjournaledAttempts, unownedLaunchFolders, verifyJournal } from './fence-verify.ts'
import type { ExecutionJournal } from './journal.ts'

/**
 * The persistent state and startup reconciliation of the global admission fence. `GlobalFenceStore` adds the runtime
 * predicate and the set/lift operations on top.
 */
export abstract class GlobalFenceStartup {
  /** Set when the installation identity is unresolved (copied home, ambiguity, corrupt registry): no admission, and
   * the person cannot lift the fence until they have resolved it (`score installation confirm-move|confirm-copy`). */
  protected hardBlock: string | null = null

  /** The installation registry says this home is a copy of another installation (until its history is reset). */
  /** Set once the journal file has been seen: its later absence is a loss, never a fresh namespace. */
  protected journalSeen = false
  protected lostHistory: string | null = null
  protected lostPersisted = false

  protected copiedFrom: string | undefined

  constructor(
    protected readonly db: ScoreDb,
    readonly journal: ExecutionJournal,
    protected readonly clock: () => number = Date.now,
    /** Announces a change (the executor emits `orchestration.fence.updated`). */
    public onChange: () => void = () => undefined,
  ) {}

  abstract set(reason: string, items: Mismatch[], options?: { untrustedHistory?: boolean }): void

  abstract lift(expectedRevision: number, note: string | undefined): void

  abstract freeze(why: string): void

  abstract executionFrozen(): string | null

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

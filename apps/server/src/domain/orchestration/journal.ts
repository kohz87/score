import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { legacyJournalScope } from '../../installation.ts'
import { LOCK_RANK, mkdirDurable, OsLock, OsLockTimeoutError } from '../../locks/os-lock.ts'
import { foldCodingEntry, foldCodingLaunches, type CodingLaunch } from './coding-records.ts'
import { compactEntries } from './journal-compaction.ts'
import { EntrySchema, type JournalEntry, type JournalEntryBody } from './journal-entry.ts'
import { parse, repairTail, syncDirectory, tailN } from './journal-files.ts'
import { foldHistory, type HistoryRead } from './journal-history.ts'
import {
  checksum,
  nodeIo,
  writeAll,
  type JournalIo,
  type JournalRead,
  type LaunchFolder,
} from './journal-io.ts'
import {
  clearRestoreMarkerAt,
  launchDirectories as readLaunchDirectories,
  readRestoreMarkerAt,
  writeHistoryMarker,
  type RestoreMarker,
} from './journal-markers.ts'
import { HISTORY_MARKER_FILE, JOURNAL_FILE, JOURNAL_SIZE_ALARM_BYTES } from './journal-paths.ts'

// The execution journal (design v3, "Restore: an external journal plus an operator protocol"): an append-only, fsync'd
// file OUTSIDE $SCORE_HOME, so restoring the home or the database cannot rewind it. Every external effect is preceded
// by an entry; on start the entries are compared with the database and anything the database lacks fences admission.
// Entries are tiny and carry no content, only identities.

/** What a critical section can do: read a launch's newest state, and append (fsync'd) under the same lock. */
interface CriticalTx {
  launch(launchId: string): CodingLaunch | undefined
  /** Every launch the journal knows for a turn (any generation), so a witnessed turn can be recognised. */
  launchesOfTurn(turnId: string): CodingLaunch[]
  /** Launches whose permanent owner is this orchestration and that may have executed (the coding step count, M4). */
  executedBy(orchestrationId: string): number
  append(body: JournalEntryBody): JournalEntry
}

/**
 * INVARIANT: no external effect is permitted by a record that recovery could discard. A writer returns only after the
 * whole record is written and the file (and, when the name is new or changed, the directory) is fsync'd; any short
 * write that cannot be completed, or any sync error, throws, and the caller must not act. Every operation that reads
 * for a decision, repairs, appends, numbers or compacts runs under one OS lock (`locks/os-lock.ts`), so two Score
 * processes (or a compaction and an append) can never interleave and lose a record.
 */
export class ExecutionJournal {
  private readonly file: string
  private readonly lock: OsLock
  private nextN: number | undefined
  private broken: string | undefined
  // Verification #5: once this handle has seen the file, its disappearance is history lost for good. Latched here so no
  // append through this handle can recreate the file and make the loss look like a fresh namespace.
  private established = false
  private vanished: string | undefined

  constructor(
    readonly dir: string,
    readonly scope: string,
    private readonly clock: () => number = Date.now,
    private readonly alarmBytes: number = JOURNAL_SIZE_ALARM_BYTES,
    private readonly io: JournalIo = nodeIo,
    lockWaitMs?: number,
    /** The lock-order rank (os-lock.ts): installation namespaces use the default; a legacy journal read during a
     * migration is taken after its namespace. */
    lockRank: number = LOCK_RANK.journal,
  ) {
    this.file = join(dir, JOURNAL_FILE)
    this.lockWaitMs = lockWaitMs
    this.lock = new OsLock(dir, (fd) => this.io.fsyncSync(fd), undefined, lockRank)
  }
  private readonly lockWaitMs: number | undefined
  private cutoverSeen = false

  private locked<T>(fn: () => T): T {
    return this.lock.runSync(fn, this.lockWaitMs)
  }

  /** Runs `fn` holding this journal's OS lock (reentrant). For multi-step operations such as a migration. */
  withLock<T>(fn: () => T): T {
    return this.locked(fn)
  }

  /**
   * The ordering point (7.7a §3): holds the journal's OS lock across the authority read, the CAS, the append+fsync and
   * the database projection the caller performs inside `fn`. `tx` sees the launches' newest state as read under the
   * lock and is kept current by its own appends. Lock order registry → journal → database is enforced by os-lock.ts.
   */
  critical<T>(fn: (tx: CriticalTx) => T): T {
    return this.locked(() => {
      if (this.broken !== undefined)
        throw new Error(`Execution journal is unreadable: ${this.broken}`)
      if (this.nextN === undefined && !this.open())
        throw new Error('Execution journal is unreadable')
      repairTail(this.file, this.io)
      const read = parse(this.file)
      if (!read.ok) {
        this.broken = read.reason
        throw new Error(`Execution journal is unreadable: ${read.reason}`)
      }
      const launches = foldCodingLaunches(
        read.entries.filter((entry) => entry.scope === this.scope),
      )
      const tx: CriticalTx = {
        launch: (launchId) => launches.get(launchId),
        launchesOfTurn: (turnId) =>
          [...launches.values()].filter((launch) => launch.state.turnId === turnId),
        executedBy: (orchestrationId) =>
          [...launches.values()].filter(
            (launch) =>
              launch.state.owner?.orchestrationId === orchestrationId &&
              launch.state.mayHaveExecuted,
          ).length,
        append: (body) => {
          const entry = this.appendLocked(body)
          foldCodingEntry(launches, entry)
          return entry
        },
      }
      return fn(tx)
    })
  }

  private historyCache: { signature: string; value: HistoryRead } | undefined
  /**
   * The reset and freeze state, read WITHOUT the journal lock (it is asked at every outgoing boundary, also inside
   * transactions) and cached while the file is unchanged. An unreadable journal is a result, not an exception: callers
   * treat it as frozen (decision 72).
   */
  historyState(): HistoryRead {
    if (this.vanished !== undefined) return { ok: false, reason: this.vanished }
    let signature = 'none'
    try {
      const stat = statSync(this.file)
      signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
      this.established = true
    } catch {
      // no file: a fresh namespace, unless this handle saw it before
      if (this.established) {
        this.vanished = 'the execution journal disappeared while Score was running'
        return { ok: false, reason: this.vanished }
      }
    }
    if (this.historyCache?.signature === signature) return this.historyCache.value
    const read = parse(this.file)
    if (!read.ok) return { ok: false, reason: read.reason }
    const value: HistoryRead = { ok: true, ...foldHistory(read.entries, this.scope) }
    this.historyCache = { signature, value }
    return value
  }

  /** True when the journal file has never been created in this directory. */
  isFresh(): boolean {
    return !existsSync(this.file)
  }

  /**
   * FZ3 #13: why a missing journal file is NOT a fresh namespace, or undefined. The folder keeps a durable "has
   * execution history" marker and per-launch receipt folders; either one without the journal means it was lost.
   */
  missingHistory(): string | undefined {
    if (existsSync(this.file)) return undefined
    if (existsSync(join(this.dir, HISTORY_MARKER_FILE)))
      return 'this folder recorded execution history (history.json), but the journal file is gone'
    const dirs = this.launchDirectories().map((folder) => folder.id)
    if (dirs.length > 0)
      return `launch folders exist (${dirs.slice(0, 3).join(', ')}${dirs.length > 3 ? ', …' : ''}) but there is no journal`
    return undefined
  }

  /** Launch folders that hold evidence (an empty folder, made before the first record, is none). */
  launchDirectories(): LaunchFolder[] {
    return readLaunchDirectories(this.dir)
  }

  private historyMarked = false
  /** Durable (temp, fsync, rename, directory fsync) and idempotent; it exists before the first record does. */
  private ensureHistoryMarker(): void {
    if (this.historyMarked) return
    writeHistoryMarker(this.dir)
    this.historyMarked = true
  }

  /** Every entry of every scope (a journal directory may be shared by test homes); callers filter by `scope`. */
  read(): JournalRead {
    let result: JournalRead
    try {
      result = this.locked(() => parse(this.file))
    } catch (error) {
      // Not being able to take the lock is not damage to the journal: report it, but don't mark the journal broken.
      if (error instanceof OsLockTimeoutError)
        return { ok: false, reason: 'the journal lock is busy', bytes: 0 }
      throw error
    }
    if (!result.ok) this.broken = result.reason
    return result
  }

  /** Entries of this home only. */
  readOwn(): JournalRead {
    const result = this.read()
    return result.ok
      ? { ...result, entries: result.entries.filter((entry) => entry.scope === this.scope) }
      : result
  }

  /** Repairs a torn tail (never effective) so appends stay line-aligned; returns false when the journal is unreadable. */
  open(): boolean {
    this.mkdirDurable()
    return this.locked(() => {
      const result = this.read()
      if (!result.ok) return false
      repairTail(this.file, this.io)
      this.nextN = (result.entries.at(-1)?.n ?? 0) + 1
      // A journal that has records (copied by a migration or a copy confirmation) is history from now on.
      if (result.entries.length > 0) this.ensureHistoryMarker()
      return true
    })
  }

  /** Creates the directory and syncs every ancestor name (see `mkdirDurable` in the OS lock module). */
  private mkdirDurable(): void {
    mkdirDurable(this.dir, (fd) => this.io.fsyncSync(fd))
  }

  /**
   * Appends the whole record and fsyncs before returning: the caller may perform the effect afterwards. Throws when it
   * cannot, and then the caller must not act (and the partial bytes, if any, are cut off again).
   */
  append(body: JournalEntryBody): JournalEntry {
    if (body.kind === 'cutover') throw new Error('Use appendCutover for a cutover record')
    return this.locked(() => this.appendLocked(body))
  }

  /** The migration's last step on the legacy journal (see journal-migration.ts). Idempotence is the caller's. */
  appendCutover(body: Extract<JournalEntryBody, { kind: 'cutover' }>): JournalEntry {
    return this.locked(() => this.appendLocked(body))
  }

  /** True once this home's records have been moved to an installation namespace: writers refuse this path. */
  private cutoverRecorded(): boolean {
    if (this.cutoverSeen) return true
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return false
    }
    if (!raw.includes('"kind":"cutover"')) return false
    for (const line of raw.split('\n')) {
      if (!line.includes('"kind":"cutover"')) continue
      try {
        const entry = JSON.parse(line) as { kind?: string; scope?: string }
        if (entry.kind === 'cutover' && entry.scope === this.scope) this.cutoverSeen = true
      } catch {
        // a torn or damaged line: parse() reports it
      }
    }
    return this.cutoverSeen
  }

  private appendLocked(body: JournalEntryBody): JournalEntry {
    if (this.established && !existsSync(this.file))
      this.vanished ??= 'the execution journal disappeared while Score was running'
    // Only the freeze record itself may follow a loss: it is the evidence a restored database can't forget.
    if (this.vanished !== undefined && body.kind !== 'execution-freeze')
      throw new Error(`Execution journal is unusable: ${this.vanished}`)
    if (this.broken !== undefined)
      throw new Error(`Execution journal is unreadable: ${this.broken}`)
    if (this.nextN === undefined && !this.open()) throw new Error('Execution journal is unreadable')
    // Another process (or handle) may have crashed mid-append or compacted: look at the file itself, under the lock.
    repairTail(this.file, this.io)
    if (body.kind !== 'cutover' && this.cutoverRecorded())
      throw new Error(
        `This journal (${this.dir}) was migrated to an installation namespace; it is a read-only witness now`,
      )
    this.nextN = Math.max(this.nextN ?? 1, tailN(this.file) + 1)
    if (body.kind !== 'cutover') this.ensureHistoryMarker()
    const entry = EntrySchema.parse({
      ...body,
      n: this.nextN!,
      at: new Date(this.clock()).toISOString(),
      scope: this.scope,
    })
    const text = JSON.stringify(entry)
    const line = Buffer.from(`${JSON.stringify({ ...entry, c: checksum(text) })}\n`)
    const fd = openSync(this.file, 'a', 0o600)
    try {
      const before = fstatSync(fd).size
      try {
        writeAll(this.io, fd, line)
        this.io.fsyncSync(fd)
      } catch (error) {
        // Part of the record may be on disk: take it off again so the file stays line-aligned. If even that fails the
        // tail repair at the next open (or append) removes it; either way the caller does not proceed.
        try {
          ftruncateSync(fd, before)
        } catch {
          // handled by repairTail
        }
        throw error
      }
    } finally {
      closeSync(fd)
    }
    // The entry is on disk now; the next number is taken whatever happens to the directory sync below.
    this.nextN = entry.n + 1
    this.established = true
    // Always, not only for a new name: a handle or process that did not create the file cannot know whether an earlier
    // writer's directory sync (or a compaction's rename sync) failed, and appends are rare enough to afford it.
    syncDirectory(this.dir, this.io)
    return entry
  }

  size(): number {
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }

  sizeAlarm(): boolean {
    return this.size() >= this.alarmBytes
  }

  /**
   * Daily compaction: drops only entries for which `droppable` says the database already records the outcome, from
   * every scope that passes. Rewrites atomically (temp file, fsync, rename); never drops anything unresolved.
   */
  compact(droppable: (entry: JournalEntry) => boolean): { kept: number; dropped: number } {
    return this.locked(() => this.compactLocked(droppable))
  }

  private compactLocked(droppable: (entry: JournalEntry) => boolean): {
    kept: number
    dropped: number
  } {
    repairTail(this.file, this.io)
    const result = this.read()
    if (!result.ok) throw new Error(`Cannot compact an unreadable journal: ${result.reason}`)
    const compacted = compactEntries(result.entries, this.scope, droppable)
    const keep = compacted.entries
    if (!compacted.changed) return { kept: keep.length, dropped: 0 }
    const text = Buffer.from(
      keep
        .map((entry) => JSON.stringify({ ...entry, c: checksum(JSON.stringify(entry)) }))
        .map((line) => `${line}\n`)
        .join(''),
    )
    const temp = `${this.file}.tmp`
    try {
      const fd = openSync(temp, 'w', 0o600)
      try {
        writeAll(this.io, fd, text)
        this.io.fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true }) // the old journal is untouched until the rename
      throw error
    }
    // Numbering continues: a later restore of an older journal copy must not look newer than this one.
    this.nextN = Math.max(this.nextN ?? 1, (result.entries.at(-1)?.n ?? 0) + 1)
    syncDirectory(this.dir, this.io)
    return { kept: keep.length, dropped: compacted.dropped }
  }

  /** The marker `scripts/restore.mjs` left for this home, if any. A malformed marker counts as present. */
  readRestoreMarker(): RestoreMarker | 'malformed' | undefined {
    return this.locked(() => readRestoreMarkerAt(this.dir, this.scope))
  }

  clearRestoreMarker(): void {
    this.locked(() => clearRestoreMarkerAt(this.dir, this.io))
  }
}

/** The legacy (path-scoped) scope of a home. Namespaced journals use the installation id as their scope instead. */
export const journalScope = legacyJournalScope

export type { JournalEntry, JournalEntryBody } from './journal-entry.ts'
export { journalDispatches } from './journal-dispatch.ts'
export { foldHistory, historyHold } from './journal-history.ts'
export { journalLine, writeAll } from './journal-io.ts'
export type { JournalIo, LaunchFolder } from './journal-io.ts'
export { HISTORY_MARKER_FILE, JOURNAL_FILE, RESTORE_MARKER_FILE } from './journal-paths.ts'

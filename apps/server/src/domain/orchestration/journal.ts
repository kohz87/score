import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { legacyJournalScope } from '../../installation.ts'
import { LOCK_RANK, mkdirDurable, OsLock, OsLockTimeoutError } from '../../locks/os-lock.ts'
import {
  CODING_RECORD_KINDS as CODING_KINDS,
  codingRecordSchemas,
  foldCodingLaunches,
  type CodingLaunch,
} from './coding-records.ts'

// The execution journal (design v3, "Restore: an external journal plus an operator protocol"): an append-only, fsync'd
// file OUTSIDE $SCORE_HOME, so restoring the home or the database cannot rewind it. Every external effect is preceded
// by an entry; on start the entries are compared with the database and anything the database lacks fences admission.
// Entries are tiny and carry no content, only identities.

export const JOURNAL_FILE = 'journal.ndjson'
export const RESTORE_MARKER_FILE = 'restore-marker.json'
/** v3.1: a size alarm at 50 MB (compaction removes reconciled entries daily; unresolved ones are never dropped). */
export const JOURNAL_SIZE_ALARM_BYTES = 50 * 1024 * 1024

const Base = { n: z.int().positive(), at: z.iso.datetime(), scope: z.string().min(1) }
const EntrySchema = z.discriminatedUnion('kind', [
  z.object({
    ...Base,
    kind: z.literal('send_started'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    attemptKind: z.enum(['lead', 'step']),
    agentId: z.string().min(1),
    generation: z.int().nonnegative(),
  }),
  // v8.2: a proven refusal (nothing reached Hermes) of dispatch generation `generation`. With the matching
  // `send_started` it says the attempt is unsent again; any later generation starts with a new `send_started`.
  z.object({
    ...Base,
    kind: z.literal('send_refused'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    generation: z.int().positive(),
  }),
  // v8.3: what compaction leaves of an attempt's older generations. Latest generation + its state keep the restore
  // check able to see a database that is behind it; `refusedCount` is informational.
  z.object({
    ...Base,
    kind: z.literal('witness'),
    attemptId: z.string().min(1),
    orchestrationId: z.string().min(1),
    lastGeneration: z.int().positive(),
    lastState: z.enum(['refused', 'sent']),
    refusedCount: z.int().nonnegative(),
  }),
  z.object({
    ...Base,
    kind: z.literal('run_handle'),
    attemptId: z.string().min(1),
    runId: z.string().min(1),
  }),
  z.object({
    ...Base,
    kind: z.literal('stop_fence'),
    orchestrationId: z.string().min(1),
    /** Set for a cancelled step: the fence is on that attempt, not on the whole run. */
    attemptId: z.string().min(1).optional(),
    reason: z.string(),
  }),
  z.object({
    ...Base,
    kind: z.literal('global_fence'),
    action: z.enum(['set', 'lift']),
    fenceSeq: z.int().nonnegative(),
    reason: z.string(),
    /** Journal entries (`n`) the person accepted as reconciled when lifting. */
    accepted: z.array(z.int().positive()).optional(),
  }),
  z.object({ ...Base, kind: z.literal('reconciled'), attemptId: z.string().min(1) }),
  // Every transition whose rollback would restore admission authority (design v3.2).
  z.object({
    ...Base,
    kind: z.literal('transition'),
    orchestrationId: z.string().min(1),
    what: z.enum(['finish', 'pause', 'resume', 'waiver', 'abandon', 'retry', 'try_again']),
    attemptIds: z.array(z.string().min(1)).optional(),
    /** Workflow decisions (retry, try_again) name their node. */
    nodeId: z.string().min(1).optional(),
  }),
  // The person's limits after every change (fix-h item 2): a database that is less restrictive than the newest one lost
  // a lowered budget, a shorter deadline or a revoked acceptance. The values are the full state, not the delta.
  z.object({
    ...Base,
    kind: z.literal('authorization'),
    orchestrationId: z.string().min(1),
    budgetUsd: z.number().nullable(),
    deadlineAt: z.string().nullable(),
    acceptUnknownSpend: z.boolean(),
  }),
  // The person's decision to use a replacement agent for the rest of the run (fix-h item 3).
  z.object({
    ...Base,
    kind: z.literal('remap'),
    orchestrationId: z.string().min(1),
    agentId: z.string().min(1),
    incarnation: z.string().min(1),
  }),
  // Team and agent pause holds live outside the orchestration tables but gate its admissions.
  z.object({
    ...Base,
    kind: z.literal('hold'),
    target: z.enum(['team', 'agent']),
    agentId: z.string().min(1).optional(),
    action: z.enum(['set', 'lift']),
  }),
  // What compaction leaves of an admission or a fence: permanent, tiny, enough to prove an older database is older.
  z.object({
    ...Base,
    kind: z.literal('tombstone'),
    of: z.enum(['send_started', 'stop_fence', 'transition']),
    orchestrationId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    /** For a send: the latest generation and whether it was sent (always `sent` for a tombstone made from a send). */
    generation: z.int().nonnegative().optional(),
    what: z
      .enum(['finish', 'pause', 'resume', 'waiver', 'abandon', 'retry', 'try_again'])
      .optional(),
    attemptIds: z.array(z.string().min(1)).optional(),
  }),
  // Keeps the sequence monotonic when compaction removed the newest entries.
  z.object({ ...Base, kind: z.literal('checkpoint') }),
  // 7.7a §2: written to the LEGACY path-scoped journal once this home's records were copied to its installation
  // namespace. After it, every writer refuses the legacy path for this home; the file stays as a read-only witness.
  z.object({
    ...Base,
    kind: z.literal('cutover'),
    installationId: z.string().min(1),
    /** The namespace directory name under the journal root (the installation id). */
    namespace: z.string().min(1),
    /** Highest legacy `n` of this home that was copied; anything of this home above it was written after the cutover. */
    copiedThrough: z.int().nonnegative(),
  }),
  // 7.7a §2/§3: coding-run records (launch-requested … settled) and their permanent tombstones.
  ...codingRecordSchemas(Base),
])
export type JournalEntry = z.infer<typeof EntrySchema>

/** What a critical section can do: read a launch's newest state, and append (fsync'd) under the same lock. */
export interface CriticalTx {
  launch(launchId: string): CodingLaunch | undefined
  append(body: JournalEntryBody): JournalEntry
}

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never
export type JournalEntryBody = DistributiveOmit<JournalEntry, 'n' | 'at' | 'scope'>

/** What the journal says about an attempt's dispatch: its latest generation and whether that one was sent. */
export interface JournalDispatch {
  generation: number
  state: 'sent' | 'refused'
  n: number
}

/** The journal's latest word on every attempt that has a `send_started` (or its tombstone, or a witness). */
export function journalDispatches(entries: readonly JournalEntry[]): Map<string, JournalDispatch> {
  const result = new Map<string, JournalDispatch>()
  for (const entry of entries) {
    if (entry.kind === 'send_started')
      result.set(entry.attemptId, { generation: entry.generation, state: 'sent', n: entry.n })
    else if (entry.kind === 'send_refused') {
      const current = result.get(entry.attemptId)
      if (!current || current.generation <= entry.generation)
        result.set(entry.attemptId, { generation: entry.generation, state: 'refused', n: entry.n })
    } else if (entry.kind === 'witness')
      result.set(entry.attemptId, {
        generation: entry.lastGeneration,
        state: entry.lastState,
        n: entry.n,
      })
    else if (entry.kind === 'tombstone' && entry.of === 'send_started' && entry.attemptId)
      result.set(entry.attemptId, { generation: entry.generation ?? 0, state: 'sent', n: entry.n })
  }
  return result
}

/** The two syscalls whose results decide durability; a seam so tests can inject short writes and sync failures. */
export interface JournalIo {
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number
  fsyncSync(fd: number): void
}
const nodeIo: JournalIo = {
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
}

/**
 * Writes the whole buffer or throws. `writeSync` may write fewer bytes than asked; a record that is only partly on disk
 * must never count as written, because recovery discards an unterminated last line as "never effective".
 */
export function writeAll(io: JournalIo, fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) {
    const written = io.writeSync(fd, data, offset, data.length - offset)
    if (!Number.isInteger(written) || written <= 0)
      throw new Error('Execution journal write made no progress')
    offset += written
  }
}

export type JournalRead =
  | { ok: true; entries: JournalEntry[]; bytes: number }
  | { ok: false; reason: string; bytes: number }

const checksum = (payload: string): string =>
  createHash('sha256').update(payload).digest('hex').slice(0, 16)

/** One journal line (record + checksum + newline), exactly as the writers produce it. */
export function journalLine(entry: JournalEntry): Buffer {
  return Buffer.from(`${JSON.stringify({ ...entry, c: checksum(JSON.stringify(entry)) })}\n`)
}

const MarkerSchema = z.object({
  scope: z.string().min(1),
  at: z.iso.datetime(),
  backup: z.string(),
  /** `copy`: written when a copied home was confirmed as its own installation (its history is the source's). */
  origin: z.enum(['restore', 'copy']).optional(),
})
export type RestoreMarker = z.infer<typeof MarkerSchema>

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
      this.repairTail()
      const read = this.parse()
      if (!read.ok) {
        this.broken = read.reason
        throw new Error(`Execution journal is unreadable: ${read.reason}`)
      }
      const launches = foldCodingLaunches(
        read.entries.filter((entry) => entry.scope === this.scope),
      )
      const tx: CriticalTx = {
        launch: (launchId) => launches.get(launchId),
        append: (body) => {
          const entry = this.appendLocked(body)
          const fold = foldCodingLaunches([entry]).get(
            (entry as { launchId?: string }).launchId ?? '',
          )
          if (fold) launches.set(fold.state.launchId, fold)
          return entry
        },
      }
      return fn(tx)
    })
  }

  /** True when the journal file has never been created in this directory. */
  isFresh(): boolean {
    return !existsSync(this.file)
  }

  private parse(): JournalRead {
    if (!existsSync(this.file)) return { ok: true, entries: [], bytes: 0 }
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      return { ok: false, reason: `unreadable: ${String(error)}`, bytes: 0 }
    }
    const bytes = Buffer.byteLength(raw)
    const lines = raw.split('\n')
    // A last line without its newline was never completely written, so its effect had not started: dropping the final
    // element handles both the empty string after a trailing newline and a torn tail.
    const complete = lines.slice(0, -1)
    const entries: JournalEntry[] = []
    let last = 0
    for (const [index, line] of complete.entries()) {
      try {
        const object = JSON.parse(line) as Record<string, unknown>
        const { c, ...body } = object
        if (typeof c !== 'string' || c !== checksum(JSON.stringify(body)))
          return { ok: false, reason: `line ${index + 1} fails its checksum`, bytes }
        const entry = EntrySchema.parse(body)
        if (entry.n <= last)
          return { ok: false, reason: `line ${index + 1} is out of sequence`, bytes }
        last = entry.n
        entries.push(entry)
      } catch {
        return { ok: false, reason: `line ${index + 1} is not a journal entry`, bytes }
      }
    }
    return { ok: true, entries, bytes }
  }

  /** Every entry of every scope (a journal directory may be shared by test homes); callers filter by `scope`. */
  read(): JournalRead {
    let result: JournalRead
    try {
      result = this.locked(() => this.parse())
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
      this.repairTail()
      this.nextN = (result.entries.at(-1)?.n ?? 0) + 1
      return true
    })
  }

  /** Creates the directory and syncs every ancestor name (see `mkdirDurable` in the OS lock module). */
  private mkdirDurable(): void {
    mkdirDurable(this.dir, (fd) => this.io.fsyncSync(fd))
  }

  /** Cuts an unterminated last line (never effective: its writer did not return) and makes the cut durable. */
  private repairTail(): void {
    if (!existsSync(this.file)) return
    const raw = readFileSync(this.file, 'utf8')
    if (raw.length === 0 || raw.endsWith('\n')) return
    const keep = raw.lastIndexOf('\n') + 1
    truncateSync(this.file, Buffer.byteLength(raw.slice(0, keep)))
    const fd = openSync(this.file, 'r+')
    try {
      this.io.fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
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
    if (this.broken !== undefined)
      throw new Error(`Execution journal is unreadable: ${this.broken}`)
    if (this.nextN === undefined && !this.open()) throw new Error('Execution journal is unreadable')
    // Another process (or handle) may have crashed mid-append or compacted: look at the file itself, under the lock.
    this.repairTail()
    if (body.kind !== 'cutover' && this.cutoverRecorded())
      throw new Error(
        `This journal (${this.dir}) was migrated to an installation namespace; it is a read-only witness now`,
      )
    this.nextN = Math.max(this.nextN ?? 1, this.tailN() + 1)
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
    // Always, not only for a new name: a handle or process that did not create the file cannot know whether an earlier
    // writer's directory sync (or a compaction's rename sync) failed, and appends are rare enough to afford it.
    this.syncDirectory()
    return entry
  }

  /** The newest entry number in the file, read from its tail. */
  private tailN(): number {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const n = (JSON.parse(lines[i]!) as { n?: unknown }).n
          if (typeof n === 'number') return n
        } catch {
          // a torn last line
        }
      }
    } catch {
      // no file yet
    }
    return 0
  }

  /** Errors propagate: a name that may not survive a crash is not a witness. */
  private syncDirectory(): void {
    const fd = openSync(this.dir, 'r')
    try {
      this.io.fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
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
    this.repairTail()
    const result = this.read()
    if (!result.ok) throw new Error(`Cannot compact an unreadable journal: ${result.reason}`)
    // Detail goes, the proof stays: an admission or a fence becomes a permanent tombstone with its original number.
    const out: JournalEntry[] = []
    const folded = foldCodingRecords(foldGenerations(result.entries, this.scope), this.scope)
    for (const entry of folded) {
      const compactable = [
        'send_started',
        'run_handle',
        'reconciled',
        'stop_fence',
        'transition',
        'authorization',
        'hold',
        'remap',
        'send_refused',
        'witness',
      ].includes(entry.kind)
      if (entry.scope !== this.scope || !compactable || !droppable(entry)) {
        out.push(entry)
      } else if (entry.kind === 'send_started') {
        out.push({
          n: entry.n,
          at: entry.at,
          scope: entry.scope,
          kind: 'tombstone',
          of: 'send_started',
          orchestrationId: entry.orchestrationId,
          attemptId: entry.attemptId,
          generation: entry.generation,
        })
      } else if (entry.kind === 'stop_fence') {
        out.push({
          n: entry.n,
          at: entry.at,
          scope: entry.scope,
          kind: 'tombstone',
          of: 'stop_fence',
          orchestrationId: entry.orchestrationId,
          ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
        })
      } else if (entry.kind === 'transition') {
        out.push({
          n: entry.n,
          at: entry.at,
          scope: entry.scope,
          kind: 'tombstone',
          of: 'transition',
          orchestrationId: entry.orchestrationId,
          what: entry.what,
          ...(entry.attemptIds ? { attemptIds: entry.attemptIds } : {}),
        })
      }
      // run_handle, reconciled, authorization and hold entries carry nothing a tombstone would keep (the caller only
      // marks them droppable once superseded or settled).
    }
    // Folded generation entries and the checkpoint below keep the sequence monotonic.
    const last = result.entries.at(-1)
    if (last && out.at(-1)?.n !== last.n)
      out.push({ n: last.n, at: last.at, scope: last.scope, kind: 'checkpoint' })
    const keep = out
    const dropped = result.entries.length - keep.length
    if (JSON.stringify(keep) === JSON.stringify(result.entries))
      return { kept: keep.length, dropped: 0 }
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
    this.syncDirectory()
    return { kept: keep.length, dropped }
  }

  /** The marker `scripts/restore.mjs` left for this home, if any. A malformed marker counts as present. */
  readRestoreMarker(): RestoreMarker | 'malformed' | undefined {
    return this.locked(() => this.readRestoreMarkerLocked())
  }

  private readRestoreMarkerLocked(): RestoreMarker | 'malformed' | undefined {
    const path = join(this.dir, RESTORE_MARKER_FILE)
    if (!existsSync(path)) return undefined
    try {
      const marker = MarkerSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      return marker.scope === this.scope ? marker : undefined
    } catch {
      return 'malformed'
    }
  }

  clearRestoreMarker(): void {
    this.locked(() => {
      const path = join(this.dir, RESTORE_MARKER_FILE)
      try {
        renameSync(path, `${path}.consumed`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // already gone
        throw error
      }
      this.syncDirectory()
    })
  }
}

/**
 * v8.3: an attempt's older dispatch generations fold into at most one entry. If the latest generation was sent, its
 * `send_started` stays and the earlier pairs go; if it was refused, one `witness` takes the place of the whole group at
 * the number of its newest entry. The latest generation, its state and the numbering are preserved, so a restored
 * database that is behind the newest generation is still detected after compaction.
 */
export function foldGenerations(entries: readonly JournalEntry[], scope: string): JournalEntry[] {
  const byAttempt = new Map<string, JournalEntry[]>()
  for (const entry of entries) {
    if (entry.scope !== scope) continue
    if (
      entry.kind === 'send_started' ||
      entry.kind === 'send_refused' ||
      entry.kind === 'witness'
    ) {
      const group = byAttempt.get(entry.attemptId) ?? []
      group.push(entry)
      byAttempt.set(entry.attemptId, group)
    }
  }
  const drop = new Set<number>()
  const replace = new Map<number, JournalEntry>()
  for (const group of byAttempt.values()) {
    if (group.length < 2) continue
    const latest = [...journalDispatches(group).values()][0]!
    const newest = group.at(-1)!
    if (latest.state === 'sent') {
      // Keep the latest send_started; everything older is superseded.
      const keep = group.findLast((e) => e.kind === 'send_started')!
      for (const e of group) if (e.n !== keep.n) drop.add(e.n)
    } else {
      const refused = group.reduce(
        (sum, e) =>
          sum + (e.kind === 'send_refused' ? 1 : e.kind === 'witness' ? e.refusedCount : 0),
        0,
      )
      for (const e of group) drop.add(e.n)
      drop.delete(newest.n)
      replace.set(newest.n, {
        n: newest.n,
        at: newest.at,
        scope: newest.scope,
        kind: 'witness',
        attemptId: (newest as { attemptId: string }).attemptId,
        orchestrationId: (newest as { orchestrationId: string }).orchestrationId,
        lastGeneration: latest.generation,
        lastState: 'refused',
        refusedCount: refused,
      })
    }
  }
  return entries.filter((e) => !drop.has(e.n)).map((e) => replace.get(e.n) ?? e)
}

/**
 * 7.7a §2: only a launch's newest coding record survives compaction, and a settled launch's becomes a compact tombstone
 * kept forever (same number). The newest record carries the launch's full state, including the monotonic "may have
 * executed" and "revoked" flags, so nothing a restore check needs is lost; an unsettled launch keeps its real record.
 */
export function foldCodingRecords(entries: readonly JournalEntry[], scope: string): JournalEntry[] {
  const newest = new Map<string, number>()
  for (const entry of entries) {
    if (entry.scope !== scope) continue
    const launchId = (entry as { launchId?: string }).launchId
    if (launchId !== undefined && isCodingKind(entry.kind)) newest.set(launchId, entry.n)
  }
  const out: JournalEntry[] = []
  for (const entry of entries) {
    const launchId = (entry as { launchId?: string }).launchId
    if (entry.scope !== scope || launchId === undefined || !isCodingKind(entry.kind)) {
      out.push(entry)
      continue
    }
    if (newest.get(launchId) !== entry.n) continue
    if (entry.kind === 'settled') {
      out.push({ ...entry, kind: 'coding-tombstone', of: 'settled' } as JournalEntry)
    } else out.push(entry)
  }
  return out
}

function isCodingKind(kind: string): boolean {
  return kind === 'coding-tombstone' || (CODING_KINDS as readonly string[]).includes(kind)
}

/** The legacy (path-scoped) scope of a home. Namespaced journals use the installation id as their scope instead. */
export const journalScope = legacyJournalScope

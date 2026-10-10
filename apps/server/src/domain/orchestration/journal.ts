import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

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
    what: z.enum(['finish', 'pause', 'resume', 'waiver', 'abandon']),
    attemptIds: z.array(z.string().min(1)).optional(),
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
    what: z.enum(['finish', 'pause', 'resume', 'waiver', 'abandon']).optional(),
    attemptIds: z.array(z.string().min(1)).optional(),
  }),
  // Keeps the sequence monotonic when compaction removed the newest entries.
  z.object({ ...Base, kind: z.literal('checkpoint') }),
])
export type JournalEntry = z.infer<typeof EntrySchema>

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never
export type JournalEntryBody = DistributiveOmit<JournalEntry, 'n' | 'at' | 'scope'>

export type JournalRead =
  | { ok: true; entries: JournalEntry[]; bytes: number }
  | { ok: false; reason: string; bytes: number }

const checksum = (payload: string): string =>
  createHash('sha256').update(payload).digest('hex').slice(0, 16)

const MarkerSchema = z.object({
  scope: z.string().min(1),
  at: z.iso.datetime(),
  backup: z.string(),
})
export type RestoreMarker = z.infer<typeof MarkerSchema>

export class ExecutionJournal {
  private readonly file: string
  private nextN: number | undefined
  private broken: string | undefined

  constructor(
    readonly dir: string,
    readonly scope: string,
    private readonly clock: () => number = Date.now,
    private readonly alarmBytes: number = JOURNAL_SIZE_ALARM_BYTES,
  ) {
    this.file = join(dir, JOURNAL_FILE)
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
    const result = this.parse()
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
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const result = this.read()
    if (!result.ok) return false
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file, 'utf8')
      if (raw.length > 0 && !raw.endsWith('\n')) {
        const keep = raw.lastIndexOf('\n') + 1
        truncateSync(this.file, Buffer.byteLength(raw.slice(0, keep)))
      }
    }
    this.nextN = (result.entries.at(-1)?.n ?? 0) + 1
    return true
  }

  /** Appends and fsyncs before returning: the caller may perform the effect afterwards. Throws when it cannot. */
  append(body: JournalEntryBody): JournalEntry {
    if (this.broken !== undefined)
      throw new Error(`Execution journal is unreadable: ${this.broken}`)
    if (this.nextN === undefined && !this.open()) throw new Error('Execution journal is unreadable')
    // Another handle on the same file (a second executor, a test) may have appended: number from the file's own tail.
    this.nextN = Math.max(this.nextN ?? 1, this.tailN() + 1)
    const entry = EntrySchema.parse({
      ...body,
      n: this.nextN!,
      at: new Date(this.clock()).toISOString(),
      scope: this.scope,
    })
    const text = JSON.stringify(entry)
    const line = `${JSON.stringify({ ...entry, c: checksum(text) })}\n`
    const fresh = !existsSync(this.file)
    const fd = openSync(this.file, 'a', 0o600)
    try {
      writeSync(fd, line)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (fresh) this.syncDirectory()
    this.nextN = entry.n + 1
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

  private syncDirectory(): void {
    try {
      const fd = openSync(this.dir, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // Best effort: some filesystems refuse to fsync a directory.
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
    const result = this.read()
    if (!result.ok) throw new Error(`Cannot compact an unreadable journal: ${result.reason}`)
    // Detail goes, the proof stays: an admission or a fence becomes a permanent tombstone with its original number.
    const out: JournalEntry[] = []
    for (const entry of result.entries) {
      const compactable = [
        'send_started',
        'run_handle',
        'reconciled',
        'stop_fence',
        'transition',
        'authorization',
        'hold',
        'remap',
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
    const last = result.entries.at(-1)
    if (last && out.at(-1)?.n !== last.n)
      out.push({ n: last.n, at: last.at, scope: last.scope, kind: 'checkpoint' })
    const keep = out
    const dropped = result.entries.length - keep.length
    if (JSON.stringify(keep) === JSON.stringify(result.entries))
      return { kept: keep.length, dropped: 0 }
    const text = keep
      .map((entry) => JSON.stringify({ ...entry, c: checksum(JSON.stringify(entry)) }))
      .map((line) => `${line}\n`)
      .join('')
    const temp = `${this.file}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.file)
    this.syncDirectory()
    // Numbering continues: a later restore of an older journal copy must not look newer than this one.
    this.nextN = Math.max(this.nextN ?? 1, (result.entries.at(-1)?.n ?? 0) + 1)
    return { kept: keep.length, dropped }
  }

  /** The marker `scripts/restore.mjs` left for this home, if any. A malformed marker counts as present. */
  readRestoreMarker(): RestoreMarker | 'malformed' | undefined {
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
    const path = join(this.dir, RESTORE_MARKER_FILE)
    try {
      renameSync(path, `${path}.consumed`)
    } catch {
      // Already gone.
    }
  }
}

/** Journal entries are scoped to a home so a shared directory never confuses two homes. */
export function journalScope(realHome: string): string {
  return createHash('sha256').update(realHome).digest('hex').slice(0, 12)
}

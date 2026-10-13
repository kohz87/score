import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { foldCodingLaunches } from './coding-records.ts'
import { LOCK_RANK, mkdirDurable } from '../../locks/os-lock.ts'
import { withRegistryLock } from '../../installation.ts'
import {
  ExecutionJournal,
  JOURNAL_FILE,
  RESTORE_MARKER_FILE,
  journalDispatches,
  journalLine,
  writeAll,
  type JournalEntry,
  type JournalIo,
} from './journal.ts'

// 7.7a design v7 §2 [v5 6]: the legacy path-scoped journal (`<journal dir>/journal.ndjson`, shared by every home that
// used the directory) is migrated into this installation's namespace while holding the registry lock, the namespace's
// own lock and the legacy journal's lock (that order). The copy is from a stable snapshot (we hold the legacy lock),
// scopes are translated to the installation id, and the last step is a fsynced, idempotent `cutover` record in the
// legacy journal. An interrupted migration restarts from the snapshot and converges. The legacy file stays as a
// read-only witness; restore markers move with the records.

export type MigrationResult =
  | { ok: true; state: 'none' | 'migrated' | 'already'; copied: number }
  | { ok: false; reason: string }

export interface MigrationOptions {
  /** Canonical journal root (where the legacy files and the namespaces live). */
  journalDir: string
  /** The legacy scope of this home (hash of its real path). */
  homeScope: string
  installationId: string
  namespaceDir: string
  io?: JournalIo
  /** Test seam: called after each durable step so a test can stop the migration there ("crash"). */
  afterStep?: (step: 'journal-copied' | 'marker-moved' | 'cutover-recorded') => void
}

function fsyncDirectory(dir: string, io: JournalIo): void {
  const fd = openSync(dir, 'r')
  try {
    io.fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeFileDurable(file: string, data: Buffer, io: JournalIo): void {
  const fd = openSync(file, 'w', 0o600)
  try {
    writeAll(io, fd, data)
    io.fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const same = (a: JournalEntry, b: JournalEntry): boolean => JSON.stringify(a) === JSON.stringify(b)

export function migrateLegacyJournal(options: MigrationOptions): MigrationResult {
  const { journalDir, homeScope, installationId, namespaceDir: nsDir } = options
  const io: JournalIo = options.io ?? {
    writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
    fsyncSync: (fd) => fsyncSync(fd),
  }
  mkdirDurable(nsDir, (fd) => io.fsyncSync(fd))
  return withRegistryLock(journalDir, () => {
    const target = new ExecutionJournal(nsDir, installationId)
    const legacy = new ExecutionJournal(
      journalDir,
      homeScope,
      undefined,
      undefined,
      undefined,
      undefined,
      LOCK_RANK.legacyJournal,
    )
    return target.withLock(() =>
      legacy.withLock(() => {
        const legacyFile = join(journalDir, JOURNAL_FILE)
        let copied = 0
        let state: 'none' | 'migrated' | 'already' = 'none'
        if (existsSync(legacyFile)) {
          const read = legacy.read()
          if (!read.ok)
            return {
              ok: false as const,
              reason: `the legacy journal is unreadable: ${read.reason}`,
            }
          const own = read.entries.filter((entry) => entry.scope === homeScope)
          const cutover = own.find((entry) => entry.kind === 'cutover')
          if (cutover) {
            if (cutover.installationId !== installationId)
              return {
                ok: false as const,
                reason: `the legacy journal says this home was migrated to installation ${cutover.installationId}, not ${installationId}`,
              }
            // The cutover only says the copy was made; the copy itself must still be there (a restored or damaged
            // namespace is not evidence), or an older database could repeat sends the legacy journal witnessed.
            const problem = destinationProblem(
              target,
              nsDir,
              installationId,
              own.filter((entry) => entry.kind !== 'cutover' && entry.n <= cutover.copiedThrough),
              cutover.copiedThrough,
            )
            if (problem) return { ok: false as const, reason: problem }
            state = 'already'
          } else if (own.length > 0) {
            const snapshot = own.map(
              (entry) => ({ ...entry, scope: installationId }) as JournalEntry,
            )
            const targetFile = join(nsDir, JOURNAL_FILE)
            if (existsSync(targetFile)) {
              // An earlier run got this far: its copy must contain every snapshot record unchanged.
              const existing = target.read()
              if (!existing.ok)
                return {
                  ok: false as const,
                  reason: `the namespace journal is unreadable: ${existing.reason}`,
                }
              const have = new Map(existing.entries.map((entry) => [entry.n, entry] as const))
              for (const entry of snapshot) {
                const found = have.get(entry.n)
                if (!found || !same(found, entry))
                  return {
                    ok: false as const,
                    reason: `the namespace journal at ${nsDir} already holds different records than the legacy journal (record ${entry.n})`,
                  }
              }
            } else {
              const temp = `${targetFile}.migrating`
              writeFileDurable(temp, Buffer.concat(snapshot.map(journalLine)), io)
              renameSync(temp, targetFile)
              fsyncDirectory(nsDir, io)
            }
            copied = snapshot.length
            state = 'migrated'
            options.afterStep?.('journal-copied')
          }
        }
        moveRestoreMarker(journalDir, nsDir, homeScope, installationId, io)
        options.afterStep?.('marker-moved')
        if (state === 'migrated') {
          const read = legacy.read()
          const through = read.ok
            ? Math.max(
                ...read.entries
                  .filter((entry) => entry.scope === homeScope)
                  .map((entry) => entry.n),
              )
            : 0
          legacy.appendCutover({
            kind: 'cutover',
            installationId,
            namespace: installationId,
            copiedThrough: through,
          })
          options.afterStep?.('cutover-recorded')
        }
        return { ok: true as const, state, copied }
      }),
    )
  })
}

/**
 * The namespace journal must still hold what the cutover says was copied: the file exists and reads, reaches the
 * copied-through number (compaction keeps the sequence), and every surviving record with a copied number agrees with the
 * legacy record of that number (compaction may have folded it into a tombstone of the same launch or attempt, but never
 * into another kind of record).
 */
function destinationProblem(
  target: ExecutionJournal,
  nsDir: string,
  installationId: string,
  snapshot: readonly JournalEntry[],
  copiedThrough: number,
): string | undefined {
  if (snapshot.length === 0 && copiedThrough === 0) return undefined
  if (!existsSync(join(nsDir, JOURNAL_FILE)))
    return `the legacy journal says this home was migrated to ${nsDir}, but that journal is missing; execution history can't be trusted`
  const read = target.read()
  if (!read.ok) return `the namespace journal at ${nsDir} is unreadable: ${read.reason}`
  // The person started a new history (`reset-history`): the legacy witnesses belong to the archived one.
  if (read.entries.some((e) => e.scope === installationId && e.kind === 'history-reset'))
    return undefined
  const have = new Map(
    read.entries.filter((e) => e.scope === installationId).map((e) => [e.n, e] as const),
  )
  const top = Math.max(0, ...have.keys())
  if (top < copiedThrough)
    return `the namespace journal at ${nsDir} ends at record ${top}, before the cutover's ${copiedThrough}: records were lost`
  const destination = [...have.values()]
  for (const entry of snapshot) {
    const found = have.get(entry.n)
    if (!found) continue // compaction may have dropped a reconciled record; the witnesses are checked below
    const translated = { ...entry, scope: installationId } as JournalEntry
    if (found.kind === translated.kind && !same(found, translated))
      return `the namespace journal at ${nsDir} holds a different record ${entry.n} than the legacy journal`
  }
  return missingWitness(snapshot, destination, nsDir)
}

/**
 * Execution authority is verified witness by witness, not by number: a later record (a checkpoint, anything) at the
 * same number never stands in for a legacy send, launch, fence or decision that is gone. Compaction may have folded a
 * witness into a tombstone, a later generation or a later phase of the same attempt/launch, and those cover it.
 */
function missingWitness(
  snapshot: readonly JournalEntry[],
  destination: readonly JournalEntry[],
  nsDir: string,
): string | undefined {
  const lost = (what: string) =>
    `the namespace journal at ${nsDir} no longer holds ${what}; execution history can't be trusted`
  // Sends: every attempt the legacy journal dispatched must be at least as far along in the destination.
  const have = journalDispatches(destination)
  for (const [attemptId, legacy] of journalDispatches(snapshot)) {
    const now = have.get(attemptId)
    if (
      !now ||
      now.generation < legacy.generation ||
      (now.generation === legacy.generation && legacy.state === 'sent' && now.state !== 'sent')
    )
      return lost(`the dispatch witness of attempt ${attemptId}`)
  }
  // Coding launches: present, same identity, and with every monotonic flag the legacy record had.
  const launches = foldCodingLaunches(destination)
  for (const [launchId, legacy] of foldCodingLaunches(snapshot)) {
    const now = launches.get(launchId)
    if (
      !now ||
      now.state.runId !== legacy.state.runId ||
      now.state.turnId !== legacy.state.turnId ||
      now.state.generation !== legacy.state.generation ||
      (legacy.state.mayHaveExecuted && !now.state.mayHaveExecuted) ||
      (legacy.state.revoked && !now.state.revoked)
    )
      return lost(`the witness of coding launch ${launchId}`)
  }
  // FZ3 #14: the other authority-bearing records. Compaction only drops a record once a later word supersedes it
  // (authorization, hold, remap) or its attempt is over (run handle), so the newest legacy word must survive.
  const authority = authorityProblem(snapshot, destination)
  if (authority) return lost(authority)
  // Fences and decisions that gate admission: kept as the record or as a tombstone of it.
  const keys = new Set(destination.map(coveringKey).filter((key) => key !== undefined))
  for (const entry of snapshot) {
    const key = coveringKey(entry)
    if (key !== undefined && !keys.has(key)) return lost(`the ${entry.kind} witness ${key}`)
  }
  return undefined
}

type Keyed = { key: string; n: number; entry: JournalEntry }

/** The newest record per key among the authority-bearing kinds that compaction keeps until superseded. */
function newestByKey(entries: readonly JournalEntry[]): Map<string, Keyed> {
  const newest = new Map<string, Keyed>()
  for (const entry of entries) {
    let key: string | undefined
    if (entry.kind === 'authorization') key = `authorization of ${entry.orchestrationId}`
    else if (entry.kind === 'hold')
      key = `hold of ${entry.target === 'team' ? 'the team' : `agent ${entry.agentId}`}`
    else if (entry.kind === 'remap') key = `remap of ${entry.agentId} in ${entry.orchestrationId}`
    else if (entry.kind === 'global_fence') key = 'global fence'
    if (key !== undefined) newest.set(key, { key, n: entry.n, entry })
  }
  return newest
}

/**
 * Every authorization, hold, remap, global fence and run handle the legacy journal holds has a successor or an identical
 * record in the destination. A run handle may only be missing together with its send record (compaction turns both
 * into tombstones once the attempt is over).
 */
function authorityProblem(
  snapshot: readonly JournalEntry[],
  destination: readonly JournalEntry[],
): string | undefined {
  const have = newestByKey(destination)
  for (const [key, legacy] of newestByKey(snapshot)) {
    const now = have.get(key)
    if (!now || now.n < legacy.n) return `the ${key}`
    if (now.n === legacy.n && !same(now.entry, { ...legacy.entry, scope: now.entry.scope }))
      return `the ${key} (a different record at ${legacy.n})`
  }
  for (const entry of snapshot) {
    if (entry.kind !== 'run_handle') continue
    const covered = destination.some(
      (other) =>
        (other.kind === 'run_handle' &&
          other.attemptId === entry.attemptId &&
          other.runId === entry.runId) ||
        (other.kind === 'tombstone' &&
          other.of === 'send_started' &&
          other.attemptId === entry.attemptId),
    )
    if (!covered) return `the run handle of attempt ${entry.attemptId}`
  }
  return undefined
}

/** What identifies a stop fence or a transition, whether it is the record or the tombstone compaction left of it. */
function coveringKey(entry: JournalEntry): string | undefined {
  const kind = entry.kind === 'tombstone' ? entry.of : entry.kind
  if (kind === 'stop_fence') {
    const e = entry as { orchestrationId: string; attemptId?: string }
    return `stop_fence:${e.orchestrationId}:${e.attemptId ?? ''}`
  }
  if (kind === 'transition') {
    const e = entry as { orchestrationId: string; what?: string; attemptIds?: string[] }
    return `transition:${e.orchestrationId}:${e.what ?? ''}:${(e.attemptIds ?? []).join(',')}`
  }
  return undefined
}

/** A restore marker for this home in the legacy directory moves into the namespace (scope translated). */
function moveRestoreMarker(
  journalDir: string,
  nsDir: string,
  homeScope: string,
  installationId: string,
  io: JournalIo,
): void {
  const legacyMarker = join(journalDir, RESTORE_MARKER_FILE)
  if (!existsSync(legacyMarker)) return
  let parsed: { scope?: unknown } | undefined
  try {
    parsed = JSON.parse(readFileSync(legacyMarker, 'utf8')) as { scope?: unknown }
  } catch {
    parsed = undefined // malformed counts as present for every home (journal.ts), so it moves
  }
  if (parsed !== undefined && parsed.scope !== homeScope) return
  const targetMarker = join(nsDir, RESTORE_MARKER_FILE)
  if (!existsSync(targetMarker)) {
    const body =
      parsed === undefined
        ? readFileSync(legacyMarker)
        : Buffer.from(JSON.stringify({ ...parsed, scope: installationId }))
    writeFileDurable(targetMarker, body, io)
    fsyncDirectory(nsDir, io)
  }
  renameSync(legacyMarker, `${legacyMarker}.migrated`)
  fsyncDirectory(journalDir, io)
  rmSync(`${legacyMarker}.tmp`, { force: true })
}

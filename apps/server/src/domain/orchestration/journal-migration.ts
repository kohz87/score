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
import { LOCK_RANK, mkdirDurable } from '../../locks/os-lock.ts'
import { withRegistryLock } from '../../installation.ts'
import {
  ExecutionJournal,
  JOURNAL_FILE,
  RESTORE_MARKER_FILE,
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

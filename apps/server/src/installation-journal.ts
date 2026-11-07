import { createHash } from 'node:crypto'
import { existsSync, fsyncSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LOCK_RANK, OsLock } from './locks/os-lock.ts'
import { JOURNAL, legacyJournalScope, namespaceDir } from './installation-identity.ts'
import { writeDurable } from './installation-io.ts'
import { isObject } from './installation-json.ts'

export const lineChecksum = (payload: string): string =>
  createHash('sha256').update(payload).digest('hex').slice(0, 16)

/**
 * The records a copy inherits: the source installation's journal, rewritten under the copy's scope (same numbers, fresh
 * checksums). The copy's database came from the source, so every execution the source has witnessed since must be
 * known to the copy before it can admit anything; with the records in the copy's namespace, its reconciliation sees the
 * sends and launches the inherited intents lack. Returns undefined, or why the source's evidence can't be trusted.
 */
export function inheritedJournal(
  journalDir: string,
  sourceId: string,
  sourceHome: string | undefined,
  newId: string,
): { lines: string; problem?: undefined } | { problem: string } {
  const own = join(namespaceDir(journalDir, sourceId), JOURNAL)
  // A source that never migrated still has its history in the legacy, path-scoped journal.
  const file = existsSync(own) ? own : join(journalDir, JOURNAL)
  const scope = file === own ? sourceId : sourceHome ? legacyJournalScope(sourceHome) : undefined
  if (!existsSync(file) || scope === undefined) return { lines: '' }
  const lines: string[] = []
  let migratedAway = false
  // Under the journal's own lock, so a running source can't be mid-append or mid-compaction while it is read.
  const lock = new OsLock(
    dirname(file),
    fsyncSync,
    undefined,
    file === own ? LOCK_RANK.journal : LOCK_RANK.legacyJournal,
  )
  let text: string
  try {
    text = lock.runSync(() => readFileSync(file, 'utf8'))
  } finally {
    lock.close()
  }
  const raw = text.split('\n')
  for (const [index, line] of raw.entries()) {
    if (!line) continue
    // An unterminated last line was never effective (journal.ts discards it on recovery).
    if (index === raw.length - 1) continue
    let entry: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isObject(parsed)) throw new Error('not a record')
      entry = parsed
    } catch {
      return { problem: `line ${index + 1} of ${file} is damaged` }
    }
    const { c, ...body } = entry
    if (c !== lineChecksum(JSON.stringify(body)))
      return { problem: `line ${index + 1} of ${file} fails its checksum` }
    if (body.scope === scope && body.kind === 'cutover') migratedAway = true
    if (body.scope !== scope || body.kind === 'cutover') continue
    // The source's reset and freeze records are its own decisions: a copy must reset its OWN history, so inheriting them
    // would let the source's reset stand in for it (decision 72).
    if (
      body.kind === 'history-reset' ||
      body.kind === 'history-reset-complete' ||
      body.kind === 'execution-freeze'
    )
      continue
    // Coding records (the only ones with a launch) are evidence in the copy, never ours to act on: the flag is part of
    // the record, so the copy's journal, its database projection and its recovery all see it.
    const copied = {
      ...body,
      scope: newId,
      ...(typeof body.launchId === 'string' ? { inherited: true } : {}),
    }
    lines.push(JSON.stringify({ ...copied, c: lineChecksum(JSON.stringify(copied)) }))
  }
  // The legacy journal says the source's history moved to its namespace, but the namespace journal is gone: what the
  // source did since then can't be known, so the copy would inherit nothing and could repeat it.
  if (migratedAway && file !== own)
    return {
      problem: `${own} is missing although the legacy journal says this installation's history moved there`,
    }
  return { lines: lines.map((line) => `${line}\n`).join('') }
}

/**
 * While the copy was unconfirmed, the hard-block start wrote its fence into the legacy journal under the copy's path
 * scope. Those records are not history to migrate (the namespace journal is already the copy's complete record and the
 * fence lives in its database): a cutover at 0 closes the legacy scope for this home, so migration finds nothing to
 * merge into the namespace and every writer refuses the legacy path from now on.
 */
export function closeLegacyScope(journalDir: string, home: string, id: string): void {
  const scope = legacyJournalScope(home)
  const file = join(journalDir, JOURNAL)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (!raw.includes(`"scope":"${scope}"`)) return
  const lock = new OsLock(journalDir, fsyncSync, undefined, LOCK_RANK.legacyJournal)
  try {
    lock.runSync(() => {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      let last = 0
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { n?: number; scope?: string; kind?: string }
          if (typeof entry.n === 'number') last = Math.max(last, entry.n)
          if (entry.scope === scope && entry.kind === 'cutover') return // already closed
        } catch {
          // a damaged line: the journal reports it
        }
      }
      const cutover = {
        n: last + 1,
        at: new Date().toISOString(),
        scope,
        kind: 'cutover',
        installationId: id,
        namespace: id,
        copiedThrough: 0,
      }
      const text = JSON.stringify({ ...cutover, c: lineChecksum(JSON.stringify(cutover)) }) + '\n'
      const raw2 = readFileSync(file, 'utf8')
      writeDurable(
        file,
        (raw2.endsWith('\n') || raw2 === '' ? raw2 : raw2.slice(0, raw2.lastIndexOf('\n') + 1)) +
          text,
      )
    })
  } finally {
    lock.close()
  }
}

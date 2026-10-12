import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

// AA3 (7.7a v5 review #3): the execution journal is only a witness if restoring the home cannot rewind it, so its
// directory must lie outside the home, judged on canonical paths (symlinks resolved, including the ones in defaults
// derived from XDG_STATE_HOME). Plain JS-compatible TypeScript: scripts/restore.mjs imports this file too.

/** Realpath of the deepest existing ancestor plus the rest, so a directory that does not exist yet still resolves. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  const rest: string[] = []
  let at = absolute
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse())
    } catch {
      const parent = dirname(at)
      if (parent === at) return absolute
      rest.push(basename(at))
      at = parent
    }
  }
}

/** A message when `journalDir` is the home or beneath it (canonically), otherwise null. */
export function journalInsideHome(journalDir: string, home: string): string | null {
  const journal = canonicalPath(journalDir)
  const root = canonicalPath(home)
  if (journal === root || journal.startsWith(root.endsWith(sep) ? root : root + sep))
    return `The execution journal directory (${journal}) must be outside the Score home (${root}): a backup or restore of the home would rewind the journal's witnesses. Set SCORE_JOURNAL_DIR to a folder outside the home.`
  return null
}

export const JOURNAL_ROOT_FILE = 'journal-root'
const JOURNAL_FILE_NAME = 'journal.ndjson'

/**
 * Refuses a journal root that differs from the one this home used before while a journal still exists at the old one:
 * starting fresh at the new root would forget every witness. Returns a message or null.
 */
export function journalRootProblem(home: string, journalDir: string): string | null {
  const pointer = join(home, JOURNAL_ROOT_FILE)
  if (!existsSync(pointer)) return null
  let old: string
  try {
    old = readFileSync(pointer, 'utf8').trim()
  } catch {
    return null
  }
  const current = canonicalPath(journalDir)
  if (!old || canonicalPath(old) === current) return null
  if (!existsSync(join(old, JOURNAL_FILE_NAME))) return null
  return `This home's execution journal is at ${old}, but the journal directory is now ${current}. Move journal.ndjson (and restore-marker.json, if present) to the new folder, or set SCORE_JOURNAL_DIR back to ${old}; then delete ${pointer} so it can be recorded again.`
}

/** Remembers the journal root for later starts and restores (creating the home if need be). */
export function recordJournalRoot(home: string, journalDir: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, JOURNAL_ROOT_FILE), canonicalPath(journalDir) + '\n', { mode: 0o600 })
}

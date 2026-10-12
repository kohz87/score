import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { mkdirDurable, OsLock } from './locks/os-lock.ts'

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

// EE3 (7.7a v6 review #3): which journal root a home uses is remembered *outside* the home (a restore replaces the
// home) and outside every journal root (a new root starts empty): `$XDG_STATE_HOME/score/roots.json`. The pointer file
// in the home stays as a convenience, never the authority.
export const JOURNAL_ROOT_FILE = 'journal-root'
const JOURNAL_FILE_NAME = 'journal.ndjson'
export const ROOTS_FILE_NAME = 'roots.json'
export const CONFIRM_ROOT_ENV = 'SCORE_CONFIRM_JOURNAL_ROOT'

type Env = Record<string, string | undefined>

export interface RootsEntry {
  current: string
  roots: { path: string; first: string; last: string }[]
}
export type Provenance =
  | { state: 'missing' }
  | { state: 'corrupt'; reason: string }
  | { state: 'ok'; homes: Record<string, RootsEntry> }

export function provenanceDir(env: Env = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'score')
}
export function provenancePath(env: Env = process.env): string {
  return join(provenanceDir(env), ROOTS_FILE_NAME)
}

function parseProvenance(raw: string): Provenance {
  try {
    const value = JSON.parse(raw) as { homes?: unknown }
    const homes = value.homes
    if (typeof homes !== 'object' || homes === null || Array.isArray(homes))
      return { state: 'corrupt', reason: 'no "homes" object' }
    for (const entry of Object.values(homes as Record<string, unknown>)) {
      const e = entry as { current?: unknown; roots?: unknown }
      if (typeof e?.current !== 'string' || !e.current || !Array.isArray(e.roots))
        return { state: 'corrupt', reason: 'a home entry is malformed' }
    }
    return { state: 'ok', homes: homes as Record<string, RootsEntry> }
  } catch (error) {
    return { state: 'corrupt', reason: error instanceof Error ? error.message : 'unreadable' }
  }
}

export function readProvenance(env: Env = process.env): Provenance {
  const file = provenancePath(env)
  if (!existsSync(file)) return { state: 'missing' }
  try {
    return parseProvenance(readFileSync(file, 'utf8'))
  } catch (error) {
    return { state: 'corrupt', reason: error instanceof Error ? error.message : 'unreadable' }
  }
}

/** What the provenance says about this home: `known` with its entry, or why it can't be trusted. */
export type HomeProvenance =
  | { state: 'known'; entry: RootsEntry }
  | { state: 'unknown' } // file fine, this home not in it
  | { state: 'missing' }
  | { state: 'corrupt'; reason: string }

export function homeProvenance(home: string, env: Env = process.env): HomeProvenance {
  const read = readProvenance(env)
  if (read.state !== 'ok') return read
  const entry = read.homes[canonicalPath(home)]
  return entry ? { state: 'known', entry } : { state: 'unknown' }
}

/**
 * Refuses a journal root that differs from the one this home used before, whatever the home's own files say: starting
 * fresh at a new root would forget every witness at the old one. `SCORE_CONFIRM_JOURNAL_ROOT=1` accepts the change
 * (after the operator has moved the journal over). Returns a message or null.
 */
export function journalRootProblem(
  home: string,
  journalDir: string,
  env: Env = process.env,
): string | null {
  const current = canonicalPath(journalDir)
  const known = homeProvenance(home, env)
  if (known.state === 'known' && known.entry.current !== current && env[CONFIRM_ROOT_ENV] !== '1')
    return `This home's execution journal was last at ${known.entry.current}, but the journal directory is now ${current}. Move journal.ndjson (and restore-marker.json, if present) to the new folder, or set SCORE_JOURNAL_DIR back to ${known.entry.current}; if you really mean to start a new journal, run once with ${CONFIRM_ROOT_ENV}=1.`
  // The home's own pointer: a convenience that catches a change even when the provenance file is gone.
  const pointer = join(home, JOURNAL_ROOT_FILE)
  if (!existsSync(pointer)) return null
  let old: string
  try {
    old = readFileSync(pointer, 'utf8').trim()
  } catch {
    return null
  }
  if (!old || canonicalPath(old) === current) return null
  if (!existsSync(join(old, JOURNAL_FILE_NAME))) return null
  if (env[CONFIRM_ROOT_ENV] === '1') return null
  return `This home's execution journal is at ${old}, but the journal directory is now ${current}. Move journal.ndjson (and restore-marker.json, if present) to the new folder, or set SCORE_JOURNAL_DIR back to ${old}; then delete ${pointer} so it can be recorded again.`
}

/**
 * Upgrade evidence when the outside record has no entry yet: the home's own pointer (written by the previous version
 * under the home lock) names exactly this root, and a journal already exists there. A home restored from a backup taken
 * before the pointer existed has no pointer, so it is still fenced.
 */
export function pointerVouches(home: string, journalDir: string): boolean {
  const pointer = join(home, JOURNAL_ROOT_FILE)
  try {
    const recorded = readFileSync(pointer, 'utf8').trim()
    return (
      recorded !== '' &&
      canonicalPath(recorded) === canonicalPath(journalDir) &&
      existsSync(join(journalDir, JOURNAL_FILE_NAME))
    )
  } catch {
    return false
  }
}

/**
 * Remembers the journal root for later starts and restores: the provenance file first (atomic, under its own OS lock,
 * and durable), then the home's convenience pointer. A corrupt provenance file is replaced only by writing this home's
 * entry into a fresh one (the start has already refused or fenced on the corruption).
 */
export function recordJournalRoot(home: string, journalDir: string, env: Env = process.env): void {
  const root = canonicalPath(journalDir)
  const key = canonicalPath(home)
  const dir = provenanceDir(env)
  const now = new Date().toISOString()
  mkdirDurable(dir)
  new OsLock(join(dir, 'roots-lock')).runSync(() => {
    const read = readProvenance(env)
    const homes = read.state === 'ok' ? read.homes : {}
    const entry = homes[key] ?? { current: root, roots: [] }
    const seen = entry.roots.find((item) => item.path === root)
    if (seen) seen.last = now
    else entry.roots.push({ path: root, first: now, last: now })
    entry.current = root
    homes[key] = entry
    const file = provenancePath(env)
    const temp = `${file}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, homes }, null, 2) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    const dirFd = openSync(dir, 'r')
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, JOURNAL_ROOT_FILE), root + '\n', { mode: 0o600 })
}

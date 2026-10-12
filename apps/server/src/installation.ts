import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { LOCK_RANK, mkdirDurable, OsLock } from './locks/os-lock.ts'
import { canonicalPath } from './journal-location.ts'

// Installation identity (7.7a design v7 §2, [v4 1, v5 4]). A durable registry OUTSIDE the home maps an installation id
// to the canonical home paths it has lived at; each id has its own journal namespace with a `manifest.json` so a lost or
// corrupt registry is rebuilt from the manifests and never mistaken for "a new path"; the home keeps a copy
// (`installation.json`). A home at a path the registry does not know is refused until the person says whether it moved
// (`score installation confirm-move`) or is a copy (`confirm-copy`). Node built-ins only, and only syntax Node can
// strip: scripts/restore.mjs and scripts/installation.mjs import this file as it is.

export const INSTALLATIONS_FILE = 'installations.json'
export const REGISTRY_LOCK_FILE = 'registry.lock.sqlite'
export const MANIFEST_FILE = 'manifest.json'
export const HOME_INSTALLATION_FILE = 'installation.json'
export const LAUNCHES_DIR = 'launches'
const RESTORE_MARKER = 'restore-marker.json'
const JOURNAL = 'journal.ndjson'
const ID_PATTERN = /^[0-9a-f]{16}$/

export function isInstallationId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}
/** The short form used in the socket path (§4). */
export const installation8 = (id: string): string => id.slice(0, 8)
export const namespaceDir = (journalDir: string, id: string): string => join(journalDir, id)

/** The scope the legacy, path-scoped journal used for a home: a hash of its real path. */
export function legacyJournalScope(realHome: string): string {
  return createHash('sha256').update(realHome).digest('hex').slice(0, 12)
}

export interface RegistryPath {
  path: string
  state: 'current' | 'moved'
  at: string
}
export interface RegistryEntry {
  createdAt: string
  copiedFrom?: string
  paths: RegistryPath[]
}
export type Installations = Record<string, RegistryEntry>

interface Manifest {
  version: 1
  id: string
  paths: string[]
  /** The path the installation lives at now. Stored, not inferred from the array's order: A → B → A leaves [A, B]. */
  current?: string
  createdAt: string
  copiedFrom?: string
}

type Registry =
  | { state: 'missing' }
  | { state: 'corrupt'; reason: string }
  | { state: 'ok'; installations: Installations }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): RegistryEntry | undefined {
  if (!isObject(value) || typeof value.createdAt !== 'string' || !Array.isArray(value.paths))
    return undefined
  const paths: RegistryPath[] = []
  for (const item of value.paths) {
    if (
      !isObject(item) ||
      typeof item.path !== 'string' ||
      !item.path ||
      (item.state !== 'current' && item.state !== 'moved') ||
      typeof item.at !== 'string'
    )
      return undefined
    paths.push({ path: item.path, state: item.state, at: item.at })
  }
  if (value.copiedFrom !== undefined && !isInstallationId(value.copiedFrom)) return undefined
  return {
    createdAt: value.createdAt,
    paths,
    ...(value.copiedFrom === undefined ? {} : { copiedFrom: value.copiedFrom as string }),
  }
}

export function readRegistry(journalDir: string): Registry {
  const file = join(journalDir, INSTALLATIONS_FILE)
  if (!existsSync(file)) return { state: 'missing' }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(value) || value.version !== 1 || !isObject(value.installations))
      return { state: 'corrupt', reason: 'not a registry file' }
    const installations: Installations = {}
    for (const [id, raw] of Object.entries(value.installations)) {
      const entry = parseEntry(raw)
      if (!isInstallationId(id) || !entry)
        return { state: 'corrupt', reason: `entry ${id} is malformed` }
      installations[id] = entry
    }
    return { state: 'ok', installations }
  } catch (error) {
    return { state: 'corrupt', reason: error instanceof Error ? error.message : 'unreadable' }
  }
}

/** The whole text or an error, then rename, then the directory: a reader sees the old file or the new one. */
function writeDurable(file: string, text: string): void {
  const temp = `${file}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeFileSync(fd, text) // loops until everything is written
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  const dirFd = openSync(dirname(file), 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

function writeRegistry(journalDir: string, installations: Installations): void {
  writeDurable(
    join(journalDir, INSTALLATIONS_FILE),
    JSON.stringify({ version: 1, installations }, null, 2) + '\n',
  )
}

function writeManifest(journalDir: string, id: string, entry: RegistryEntry): void {
  const manifest: Manifest = {
    version: 1,
    id,
    paths: entry.paths.map((item) => item.path),
    ...(entry.paths.some((item) => item.state === 'current')
      ? { current: entry.paths.find((item) => item.state === 'current')!.path }
      : {}),
    createdAt: entry.createdAt,
    ...(entry.copiedFrom === undefined ? {} : { copiedFrom: entry.copiedFrom }),
  }
  writeDurable(
    join(namespaceDir(journalDir, id), MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
  )
}

function readManifests(journalDir: string): { valid: Manifest[]; invalid: string[] } {
  const valid: Manifest[] = []
  const invalid: string[] = []
  let names: string[]
  try {
    names = readdirSync(journalDir)
  } catch {
    return { valid, invalid }
  }
  for (const name of names) {
    if (!isInstallationId(name)) continue
    const file = join(journalDir, name, MANIFEST_FILE)
    if (!existsSync(join(journalDir, name))) continue
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (
        !isObject(value) ||
        value.version !== 1 ||
        value.id !== name ||
        !Array.isArray(value.paths) ||
        !value.paths.every((item) => typeof item === 'string' && item) ||
        typeof value.createdAt !== 'string'
      )
        throw new Error('malformed')
      valid.push({
        version: 1,
        id: name,
        paths: value.paths as string[],
        createdAt: value.createdAt,
        ...(typeof value.current === 'string' && value.paths.includes(value.current)
          ? { current: value.current }
          : {}),
        ...(isInstallationId(value.copiedFrom) ? { copiedFrom: value.copiedFrom } : {}),
      })
    } catch {
      invalid.push(name)
    }
  }
  return { valid, invalid }
}

type HomeFile = { state: 'missing' } | { state: 'corrupt' } | { state: 'ok'; id: string }

export function readHomeInstallation(home: string): HomeFile {
  const file = join(home, HOME_INSTALLATION_FILE)
  if (!existsSync(file)) return { state: 'missing' }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isObject(value) && isInstallationId(value.id)) return { state: 'ok', id: value.id }
  } catch {
    // corrupt
  }
  return { state: 'corrupt' }
}

export function writeHomeInstallation(home: string, id: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeDurable(join(home, HOME_INSTALLATION_FILE), JSON.stringify({ version: 1, id }) + '\n')
}

/** Runs `fn` holding the registry-wide OS lock. Lock order: registry → installation journal → database. */
export function withRegistryLock<T>(journalDir: string, fn: () => T): T {
  const lock = new OsLock(journalDir, fsyncSync, REGISTRY_LOCK_FILE, LOCK_RANK.registry)
  try {
    return lock.runSync(fn)
  } finally {
    lock.close()
  }
}

/** The legacy journal's cutover for this home, read without verifying checksums (the id is validated instead). */
function legacyCutoverId(journalDir: string, homeScope: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(join(journalDir, JOURNAL), 'utf8')
  } catch {
    return undefined
  }
  if (!raw.includes('"kind":"cutover"')) return undefined
  let found: string | undefined
  for (const line of raw.split('\n')) {
    if (!line.includes('"kind":"cutover"')) continue
    try {
      const entry: unknown = JSON.parse(line)
      if (isObject(entry) && entry.scope === homeScope && isInstallationId(entry.namespace))
        found = entry.namespace
    } catch {
      // a damaged line: the migration code reports it
    }
  }
  return found
}

export type InstallationProblem =
  'registry_corrupt' | 'ambiguous_path' | 'id_conflict' | 'unconfirmed_path' | 'moved_away'

export type InstallationResult =
  | {
      ok: true
      id: string
      namespaceDir: string
      /** How the id was obtained: it was already agreed, recovered from the registry/manifests/legacy cutover, adopted
       * from the home's own copy, or newly minted. */
      how: 'existing' | 'recovered' | 'adopted' | 'created'
    }
  | { ok: false; code: InstallationProblem; message: string; id?: string }

export interface ResolveOptions {
  journalDir: string
  home: string
  now?: () => string
  mintId?: () => string
}

const mint = (): string => randomBytes(8).toString('hex')
const nowIso = (): string => new Date().toISOString()

/** The registry as it should be: the file, plus any namespace manifest the file lacks (a lost or damaged registry). */
type LoadedRegistry =
  | { ok: true; installations: Installations; rebuilt: boolean }
  | { ok: false; code: 'registry_corrupt'; message: string }

function loadRegistry(journalDir: string): LoadedRegistry {
  const registry = readRegistry(journalDir)
  const manifests = readManifests(journalDir)
  if (registry.state !== 'ok' && manifests.invalid.length > 0)
    return {
      ok: false,
      code: 'registry_corrupt',
      message: `The installation registry (${join(journalDir, INSTALLATIONS_FILE)}) is ${registry.state === 'corrupt' ? 'unreadable' : 'missing'} and the manifest of ${manifests.invalid.join(', ')} is damaged, so Score cannot tell which installation this home is. Restore ${INSTALLATIONS_FILE} from a backup, or repair ${MANIFEST_FILE} in that folder.`,
    }
  if (registry.state === 'corrupt' && manifests.valid.length === 0)
    return {
      ok: false,
      code: 'registry_corrupt',
      message: `The installation registry (${join(journalDir, INSTALLATIONS_FILE)}) is unreadable (${registry.reason}) and no installation manifest survives to rebuild it from. Restore it from a backup; coding and orchestration stay blocked until then.`,
    }
  const installations: Installations =
    registry.state === 'ok' ? structuredClone(registry.installations) : {}
  let rebuilt = registry.state !== 'ok'
  for (const manifest of manifests.valid) {
    if (installations[manifest.id]) continue
    installations[manifest.id] = {
      createdAt: manifest.createdAt,
      ...(manifest.copiedFrom === undefined ? {} : { copiedFrom: manifest.copiedFrom }),
      // The manifest names its current path; one from before that field existed falls back to the newest (last) path.
      paths: manifest.paths.map((path) => ({
        path,
        state:
          path === (manifest.current ?? manifest.paths.at(-1))
            ? ('current' as const)
            : ('moved' as const),
        at: manifest.createdAt,
      })),
    }
    rebuilt = true
  }
  return { ok: true, installations, rebuilt }
}

const claimsOf = (installations: Installations, home: string): string[] =>
  Object.entries(installations)
    .filter(([, entry]) => entry.paths.some((item) => item.path === home))
    .map(([id]) => id)

/** Setup that is safe to repeat: namespace and `launches/` directories (each parent synced), manifest, home copy. */
function ensureSetup(journalDir: string, id: string, entry: RegistryEntry, home: string): void {
  const dir = namespaceDir(journalDir, id)
  mkdirDurable(join(dir, LAUNCHES_DIR))
  writeManifest(journalDir, id, entry)
  const copy = readHomeInstallation(home)
  if (copy.state !== 'ok' || copy.id !== id) writeHomeInstallation(home, id)
}

export function resolveInstallation(options: ResolveOptions): InstallationResult {
  const journalDir = canonicalPath(options.journalDir)
  const home = canonicalPath(options.home)
  const now = options.now ?? nowIso
  mkdirDurable(journalDir)
  return withRegistryLock(journalDir, () => {
    const loaded = loadRegistry(journalDir)
    if (!loaded.ok) return loaded
    const { installations } = loaded
    const copy = readHomeInstallation(home)
    const claims = claimsOf(installations, home)
    if (claims.length > 1)
      return {
        ok: false,
        code: 'ambiguous_path',
        message: `${claims.length} installations (${claims.join(', ')}) claim ${home} in ${join(journalDir, INSTALLATIONS_FILE)}. Remove the wrong entries (and their folders) before starting; coding and orchestration stay blocked until then.`,
      }
    if (claims.length === 1) {
      const id = claims[0]!
      const entry = installations[id]!
      const mine = entry.paths.find((item) => item.path === home)!
      if (mine.state === 'moved')
        return {
          ok: false,
          code: 'moved_away',
          id,
          message: `${home} was recorded as moved away from installation ${id} (now at ${entry.paths.find((item) => item.state === 'current')?.path ?? 'another folder'}). If this folder is a copy, run \`score installation confirm-copy\`; to use this folder as the installation again, run \`score installation confirm-move\`.`,
        }
      if (copy.state === 'ok' && copy.id !== id)
        return {
          ok: false,
          code: 'id_conflict',
          id,
          message: `The home says it is installation ${copy.id}, but the registry says ${home} is ${id}. Coding and orchestration stay blocked until you resolve this: restore the home's installation.json, or fix ${join(journalDir, INSTALLATIONS_FILE)}.`,
        }
      if (loaded.rebuilt) writeRegistry(journalDir, installations)
      ensureSetup(journalDir, id, entry, home)
      return {
        ok: true,
        id,
        namespaceDir: namespaceDir(journalDir, id),
        how: copy.state === 'ok' && !loaded.rebuilt ? 'existing' : 'recovered',
      }
    }
    // No entry for this path.
    if (copy.state === 'ok' && installations[copy.id]) {
      const known = installations[copy.id]!
      return {
        ok: false,
        code: 'unconfirmed_path',
        id: copy.id,
        message: `This home says it is installation ${copy.id}, which Score knows at ${known.paths.find((item) => item.state === 'current')?.path ?? 'another folder'}, not at ${home}. If you moved or renamed the folder, run \`score installation confirm-move\`; if it is a copy, run \`score installation confirm-copy\`. Coding and orchestration stay blocked until you do.`,
      }
    }
    // The home's own copy names an installation nothing else remembers, or the legacy journal's cutover names one:
    // adopt that id (never mint a second one for a path that already has history), registry first.
    const fromCutover = legacyCutoverId(journalDir, legacyJournalScope(home))
    const adoptedId = copy.state === 'ok' ? copy.id : fromCutover
    const id = adoptedId ?? (options.mintId ?? mint)()
    if (installations[id]) throw new Error('Installation id collision')
    const entry: RegistryEntry = {
      createdAt: now(),
      paths: [{ path: home, state: 'current', at: now() }],
    }
    installations[id] = entry
    writeRegistry(journalDir, installations) // the registry entry first, then anything that names the id
    ensureSetup(journalDir, id, entry, home)
    return {
      ok: true,
      id,
      namespaceDir: namespaceDir(journalDir, id),
      how: adoptedId === undefined ? 'created' : copy.state === 'ok' ? 'adopted' : 'recovered',
    }
  })
}

const lineChecksum = (payload: string): string =>
  createHash('sha256').update(payload).digest('hex').slice(0, 16)

/**
 * The records a copy inherits: the source installation's journal, rewritten under the copy's scope (same numbers, fresh
 * checksums). The copy's database came from the source, so every execution the source has witnessed since must be
 * known to the copy before it can admit anything; with the records in the copy's namespace, its reconciliation sees the
 * sends and launches the inherited intents lack. Returns undefined, or why the source's evidence can't be trusted.
 */
function inheritedJournal(
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
    if (body.scope !== scope || body.kind === 'cutover') continue
    const copied = { ...body, scope: newId }
    lines.push(JSON.stringify({ ...copied, c: lineChecksum(JSON.stringify(copied)) }))
  }
  return { lines: lines.map((line) => `${line}\n`).join('') }
}

export type ConfirmResult =
  { ok: true; id: string; changed: boolean; message: string } | { ok: false; message: string }

/** The folder moved or was renamed: it keeps its installation (and journal); the old path becomes a refused alias. */
export function confirmMove(options: ResolveOptions): ConfirmResult {
  const journalDir = canonicalPath(options.journalDir)
  const home = canonicalPath(options.home)
  const now = (options.now ?? nowIso)()
  return withRegistryLock(journalDir, () => {
    const loaded = loadRegistry(journalDir)
    if (!loaded.ok) return { ok: false, message: loaded.message }
    const copy = readHomeInstallation(home)
    if (copy.state !== 'ok')
      return { ok: false, message: `${home} has no ${HOME_INSTALLATION_FILE}: nothing to confirm.` }
    const entry = loaded.installations[copy.id]
    if (!entry)
      return {
        ok: false,
        message: `Score does not know installation ${copy.id}; just start Score.`,
      }
    const other = claimsOf(loaded.installations, home).filter((id) => id !== copy.id)
    if (other.length > 0)
      return {
        ok: false,
        message: `${home} is recorded for ${other.join(', ')}; resolve that first.`,
      }
    const mine = entry.paths.find((item) => item.path === home)
    if (mine?.state === 'current')
      return {
        ok: true,
        id: copy.id,
        changed: false,
        message: `${home} is already the current location.`,
      }
    for (const item of entry.paths) if (item.state === 'current') item.state = 'moved'
    if (mine) {
      mine.state = 'current'
      mine.at = now
    } else entry.paths.push({ path: home, state: 'current', at: now })
    writeRegistry(journalDir, loaded.installations)
    mkdirDurable(namespaceDir(journalDir, copy.id))
    writeManifest(journalDir, copy.id, entry)
    return {
      ok: true,
      id: copy.id,
      changed: true,
      message: `Installation ${copy.id} now lives at ${home}. Restart Score.`,
    }
  })
}

/** The folder is a copy: it gets its own installation, and the history it inherited is marked untrusted at next start. */
export function confirmCopy(options: ResolveOptions): ConfirmResult {
  const journalDir = canonicalPath(options.journalDir)
  const home = canonicalPath(options.home)
  const now = (options.now ?? nowIso)()
  return withRegistryLock(journalDir, () => {
    const loaded = loadRegistry(journalDir)
    if (!loaded.ok) return { ok: false, message: loaded.message }
    const copy = readHomeInstallation(home)
    if (copy.state !== 'ok')
      return { ok: false, message: `${home} has no ${HOME_INSTALLATION_FILE}: nothing to confirm.` }
    if (!loaded.installations[copy.id])
      return {
        ok: false,
        message: `Score does not know installation ${copy.id}; just start Score.`,
      }
    const claims = claimsOf(loaded.installations, home)
    if (claims.length > 0)
      return {
        ok: false,
        message: `${home} already belongs to installation ${claims.join(', ')}; it is not an unconfirmed copy.`,
      }
    const id = (options.mintId ?? mint)()
    if (loaded.installations[id]) throw new Error('Installation id collision')
    const entry: RegistryEntry = {
      createdAt: now,
      copiedFrom: copy.id,
      paths: [{ path: home, state: 'current', at: now }],
    }
    // Before the copy becomes an admissible identity: its namespace holds the source's evidence and the marker that
    // fences it. A crash anywhere in here leaves a namespace nothing refers to, and the next confirm starts over.
    const source = loaded.installations[copy.id]!
    const inherited = inheritedJournal(
      journalDir,
      copy.id,
      source.paths.find((item) => item.state === 'current')?.path,
      id,
    )
    if (inherited.problem !== undefined)
      return {
        ok: false,
        message: `The source installation ${copy.id}'s execution journal can't be trusted: ${inherited.problem}. Resolve that first; nothing was changed.`,
      }
    const nsDir = namespaceDir(journalDir, id)
    mkdirDurable(join(nsDir, LAUNCHES_DIR))
    if (inherited.lines) writeDurable(join(nsDir, JOURNAL), inherited.lines)
    writeDurable(
      join(nsDir, RESTORE_MARKER),
      JSON.stringify({ scope: id, at: now, backup: `installation ${copy.id}`, origin: 'copy' }),
    )
    loaded.installations[id] = entry
    writeRegistry(journalDir, loaded.installations) // the registry entry before anything that makes the id usable
    ensureSetup(journalDir, id, entry, home)
    return {
      ok: true,
      id,
      changed: true,
      message: `${home} is now its own installation (${id}), copied from ${copy.id}. The next start fences admission until you review the inherited history.`,
    }
  })
}

/**
 * Where `scripts/restore.mjs` writes its marker: the namespace the legacy journal's cutover names, else the one the
 * registry gives this home's path, else the legacy directory (a home that was never migrated).
 */
export function restoreMarkerDir(journalDirRequested: string, homeRequested: string): string {
  const journalDir = canonicalPath(journalDirRequested)
  const home = canonicalPath(homeRequested)
  const cutover = legacyCutoverId(journalDir, legacyJournalScope(home))
  if (cutover) return namespaceDir(journalDir, cutover)
  if (
    !existsSync(join(journalDir, INSTALLATIONS_FILE)) &&
    readManifests(journalDir).valid.length === 0
  )
    return journalDir
  return withRegistryLock(journalDir, () => {
    const loaded = loadRegistry(journalDir)
    if (!loaded.ok) throw new Error(loaded.message)
    const claims = claimsOf(loaded.installations, home)
    if (claims.length > 1)
      throw new Error(`${claims.length} installations claim ${home}; resolve the registry first.`)
    return claims.length === 1 ? namespaceDir(journalDir, claims[0]!) : journalDir
  })
}

/** The installation id the registry gives this path (for the restored home's copy), if any. Read-only. */
export function registeredIdForHome(
  journalDirRequested: string,
  homeRequested: string,
): string | undefined {
  const journalDir = canonicalPath(journalDirRequested)
  const home = canonicalPath(homeRequested)
  const registry = readRegistry(journalDir)
  if (registry.state !== 'ok') return undefined
  const claims = claimsOf(registry.installations, home)
  return claims.length === 1 ? claims[0] : undefined
}

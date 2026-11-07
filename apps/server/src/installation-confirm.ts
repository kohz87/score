import { join } from 'node:path'
import { mkdirDurable } from './locks/os-lock.ts'
import { canonicalPath } from './journal-location.ts'
import {
  HISTORY_MARKER,
  HOME_INSTALLATION_FILE,
  JOURNAL,
  LAUNCHES_DIR,
  RESTORE_MARKER,
  namespaceDir,
} from './installation-identity.ts'
import { writeDurable } from './installation-io.ts'
import { readHomeInstallation } from './installation-home.ts'
import { closeLegacyScope, inheritedJournal } from './installation-journal.ts'
import { withRegistryLock, writeManifest, writeRegistry } from './installation-registry.ts'
import { claimsOf, ensureSetup, loadRegistry, mint, nowIso } from './installation-resolve.ts'
import type { ConfirmResult, RegistryEntry, ResolveOptions } from './installation-types.ts'

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
    writeDurable(join(nsDir, JOURNAL), inherited.lines)
    writeDurable(join(nsDir, HISTORY_MARKER), JSON.stringify({ version: 1, at: now }))
    writeDurable(
      join(nsDir, RESTORE_MARKER),
      JSON.stringify({ scope: id, at: now, backup: `installation ${copy.id}`, origin: 'copy' }),
    )
    loaded.installations[id] = entry
    writeRegistry(journalDir, loaded.installations) // the registry entry before anything that makes the id usable
    ensureSetup(journalDir, id, entry, home)
    closeLegacyScope(journalDir, home, id)
    return {
      ok: true,
      id,
      changed: true,
      message: `${home} is now its own installation (${id}), copied from ${copy.id}. Score holds all agent work in it until you run \`scripts/score installation reset-history\`.`,
    }
  })
}

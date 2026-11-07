import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from './journal-location.ts'
import { INSTALLATIONS_FILE, legacyJournalScope, namespaceDir } from './installation-identity.ts'
import {
  legacyCutoverId,
  readManifests,
  readRegistry,
  withRegistryLock,
} from './installation-registry.ts'
import { claimsOf, loadRegistry } from './installation-resolve.ts'

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

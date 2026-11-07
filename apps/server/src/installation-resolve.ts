import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdirDurable } from './locks/os-lock.ts'
import { canonicalPath } from './journal-location.ts'
import {
  INSTALLATIONS_FILE,
  LAUNCHES_DIR,
  MANIFEST_FILE,
  legacyJournalScope,
  namespaceDir,
} from './installation-identity.ts'
import { readHomeInstallation, writeHomeInstallation } from './installation-home.ts'
import {
  legacyCutoverId,
  readManifests,
  readRegistry,
  withRegistryLock,
  writeManifest,
  writeRegistry,
} from './installation-registry.ts'
import type {
  Installations,
  RegistryEntry,
  ResolveOptions,
  InstallationResult,
} from './installation-types.ts'

export const mint = (): string => randomBytes(8).toString('hex')
export const nowIso = (): string => new Date().toISOString()

/** The registry as it should be: the file, plus any namespace manifest the file lacks (a lost or damaged registry). */
export type LoadedRegistry =
  | { ok: true; installations: Installations; rebuilt: boolean }
  | { ok: false; code: 'registry_corrupt'; message: string }

export function loadRegistry(journalDir: string): LoadedRegistry {
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

export const claimsOf = (installations: Installations, home: string): string[] =>
  Object.entries(installations)
    .filter(([, entry]) => entry.paths.some((item) => item.path === home))
    .map(([id]) => id)

/** Setup that is safe to repeat: namespace and `launches/` directories (each parent synced), manifest, home copy. */
export function ensureSetup(
  journalDir: string,
  id: string,
  entry: RegistryEntry,
  home: string,
): void {
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
        ...(entry.copiedFrom === undefined ? {} : { copiedFrom: entry.copiedFrom }),
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

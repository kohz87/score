import { existsSync, fsyncSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LOCK_RANK, OsLock } from './locks/os-lock.ts'
import {
  INSTALLATIONS_FILE,
  JOURNAL,
  MANIFEST_FILE,
  REGISTRY_LOCK_FILE,
  isInstallationId,
  namespaceDir,
} from './installation-identity.ts'
import { writeDurable } from './installation-io.ts'
import { isObject, parseEntry } from './installation-json.ts'
import type { Installations, Manifest, Registry, RegistryEntry } from './installation-types.ts'

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

export function writeRegistry(journalDir: string, installations: Installations): void {
  writeDurable(
    join(journalDir, INSTALLATIONS_FILE),
    JSON.stringify({ version: 1, installations }, null, 2) + '\n',
  )
}

export function writeManifest(journalDir: string, id: string, entry: RegistryEntry): void {
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

export function readManifests(journalDir: string): { valid: Manifest[]; invalid: string[] } {
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
export function legacyCutoverId(journalDir: string, homeScope: string): string | undefined {
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

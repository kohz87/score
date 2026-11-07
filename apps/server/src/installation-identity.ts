import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const INSTALLATIONS_FILE = 'installations.json'
export const REGISTRY_LOCK_FILE = 'registry.lock.sqlite'
export const MANIFEST_FILE = 'manifest.json'
export const HOME_INSTALLATION_FILE = 'installation.json'
export const LAUNCHES_DIR = 'launches'
export const RESTORE_MARKER = 'restore-marker.json'
export const HISTORY_MARKER = 'history.json'
export const JOURNAL = 'journal.ndjson'
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

// Installation identity (7.7a design v7 §2, [v4 1, v5 4]). A durable registry OUTSIDE the home maps an installation id
// to the canonical home paths it has lived at; each id has its own journal namespace with a `manifest.json` so a lost or
// corrupt registry is rebuilt from the manifests and never mistaken for "a new path"; the home keeps a copy
// (`installation.json`). A home at a path the registry does not know is refused until the person says whether it moved
// (`score installation confirm-move`) or is a copy (`confirm-copy`). Node built-ins only, and only syntax Node can
// strip: scripts/restore.mjs and scripts/installation.mjs import this file as it is.

export {
  HISTORY_MARKER,
  HOME_INSTALLATION_FILE,
  INSTALLATIONS_FILE,
  JOURNAL,
  LAUNCHES_DIR,
  MANIFEST_FILE,
  REGISTRY_LOCK_FILE,
  installation8,
  isInstallationId,
  legacyJournalScope,
  namespaceDir,
} from './installation-identity.ts'
export { writeDurable } from './installation-io.ts'
export { readHomeInstallation, writeHomeInstallation } from './installation-home.ts'
export { readRegistry, withRegistryLock } from './installation-registry.ts'
export { resolveInstallation } from './installation-resolve.ts'
export { lineChecksum } from './installation-journal.ts'
export { confirmCopy, confirmMove } from './installation-confirm.ts'
export { registeredIdForHome, restoreMarkerDir } from './installation-restore.ts'
export type {
  ConfirmResult,
  InstallationProblem,
  InstallationResult,
  Installations,
  RegistryEntry,
  RegistryPath,
  ResolveOptions,
} from './installation-types.ts'

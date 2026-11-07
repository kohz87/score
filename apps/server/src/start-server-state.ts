import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveJournalDir, type Config } from './config.ts'
import { acquireHomeLock, migrate, openDatabase, resetEpoch, type ScoreDb } from './db/index.ts'
import { ensureMessageFts } from './db/fts.ts'
import { deriveAgentStatusEvents } from './domain/agent-status.ts'
import { deriveBriefEvents } from './domain/briefs.ts'
import { migrateLegacyJournal } from './domain/orchestration/journal-migration.ts'
import { deriveRoomEvents } from './domain/rooms.ts'
import { restoreRoomHolds } from './domain/room-rewinding.ts'
import { deriveTaskEvents } from './domain/tasks.ts'
import { kanbanAttemptsEnabled, seedFakeAttempts } from './hermes/index.ts'
import { createIngest, type Ingest } from './hub/ingest.ts'
import { resolveInstallation, type InstallationResult } from './installation.ts'
import {
  canonicalPath,
  homeProvenance,
  journalInsideHome,
  journalRootProblem,
  pointerVouches,
  recordJournalRoot,
} from './journal-location.ts'
import { journalScope } from './domain/orchestration/journal.ts'

/** The home's identity for the execution journal: its real path (a symlinked home is the same home). */
export function realHome(home: string): string {
  try {
    return realpathSync(home)
  } catch {
    return resolve(home)
  }
}

export interface ScoreStartupState {
  rootProvenance: ReturnType<typeof homeProvenance> | undefined
  installation: InstallationResult | undefined
  installationBlock: string | null
  database: ScoreDb
  ingest: Ingest
}

export function initializeScoreState(
  config: Config,
  onHomeLock: (lock: ReturnType<typeof acquireHomeLock>) => void,
  onDatabase: (database: ScoreDb) => void,
): ScoreStartupState {
  let rootProvenance: ReturnType<typeof homeProvenance> | undefined
  // 7.7a §2: who this home is. Unresolved (copied home, ambiguity, corrupt registry) blocks every admission.
  let installation: InstallationResult | undefined
  let installationBlock: string | null = null
  // Before any lock, marker or write: a live journal inside the home would be rewound by a restore (AA3).
  // The fake adapter starts no real runs, so its journal may stay in the home.
  if (config.mode !== 'fake') {
    const inside = journalInsideHome(resolveJournalDir(config), config.home)
    if (inside) throw new Error(inside)
  }
  const homeLock = acquireHomeLock(config.home)
  onHomeLock(homeLock)
  if (config.mode !== 'fake') {
    const moved = journalRootProblem(config.home, resolveJournalDir(config))
    if (moved) throw new Error(moved)
    // Read before recording: it says whether anything outside the home vouched for this home's journal root.
    rootProvenance = homeProvenance(config.home)
    // First start after the upgrade: the home's pointer and an existing journal at that root vouch for it.
    if (
      (rootProvenance.state === 'missing' || rootProvenance.state === 'unknown') &&
      pointerVouches(config.home, resolveJournalDir(config))
    )
      rootProvenance = undefined
    recordJournalRoot(config.home, resolveJournalDir(config))
  }
  {
    const journalRoot = resolveJournalDir(config)
    const home = realHome(config.home)
    installation = resolveInstallation({ journalDir: journalRoot, home })
    if (!installation.ok) installationBlock = installation.message
    else {
      const migrated = migrateLegacyJournal({
        journalDir: canonicalPath(journalRoot),
        homeScope: journalScope(home),
        installationId: installation.id,
        namespaceDir: installation.namespaceDir,
      })
      if (!migrated.ok)
        installationBlock = `The execution journal could not be moved into this installation's folder: ${migrated.reason}`
    }
  }
  const database = openDatabase(join(config.home, 'score.db'))
  onDatabase(database)
  migrate(database, fileURLToPath(new URL('../migrations/', import.meta.url)))
  restoreRoomHolds(database.sqlite, Date.now())
  ensureMessageFts(database.sqlite)
  // Test-only: attempts for e2e against the fake adapter (it has no Kanban board to project from).
  if (
    config.mode === 'fake' &&
    kanbanAttemptsEnabled() &&
    process.env.SCORE_E2E_SEED_ATTEMPTS === '1'
  )
    seedFakeAttempts(database.sqlite)
  // A new epoch per start: a database restored from a backup may have caught up past a browser's cursor,
  // and only a changed epoch tells that browser its projections came from discarded history.
  resetEpoch(database)
  const ingest = createIngest(database, {
    deriveEvents: (sqlite, drafts, context) => [
      ...deriveTaskEvents(sqlite, drafts, context),
      ...deriveRoomEvents(sqlite, drafts, context),
      ...deriveBriefEvents(sqlite, drafts, context),
      ...deriveAgentStatusEvents(sqlite, drafts, context),
    ],
  })
  return { rootProvenance, installation, installationBlock, database, ingest }
}

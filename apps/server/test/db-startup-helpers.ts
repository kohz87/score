import { rmSync } from 'node:fs'
import { afterEach, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const mocksRelease = vi.fn()
  const db = {
    close: vi.fn(),
    sqlite: {
      prepare: vi.fn(() => ({ get: vi.fn(() => undefined), run: vi.fn(), all: vi.fn(() => []) })),
    },
  }
  const app = {
    pairing: { createToken: vi.fn(() => 'pairing-token') },
    listen: vi.fn(async () => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
    log: { error: vi.fn() },
    recoverTaskHolds: undefined as (() => Promise<number>) | undefined,
  }
  return {
    db,
    app,
    openDatabase: vi.fn(() => db),
    migrate: vi.fn(),
    buildApp: vi.fn(() => app),
    storeConstructor: vi.fn(),
    acquireHomeLock: vi.fn(() => ({ release: mocksRelease })),
    release: mocksRelease,
    ingest: {
      close: vi.fn(async (): Promise<void> => undefined),
      submit: vi.fn(async () => undefined),
    },
    outbox: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sweep: vi.fn(async () => undefined),
    },
    port: {
      start: vi.fn(async (): Promise<void> => undefined),
      stop: vi.fn(async (): Promise<void> => undefined),
      status: vi.fn(() => ({
        compatibility: { fingerprint: 'fixture', tested: true, disabled: [] },
      })),
    },
    createHermesPort: vi.fn(),
    createIngest: vi.fn(),
    getEpoch: vi.fn(() => 'epoch'),
    pruneEvents: vi.fn(),
    pruneBridge: vi.fn(),
    createScreenshotImporter: vi.fn(() => vi.fn()),
    sweepKanbanDenials: vi.fn(async () => undefined),
    retireIngestKeys: vi.fn(),
    loadBridgeBootstrap: vi.fn(() => Buffer.alloc(32)),
    snapshotSessionCosts: vi.fn(async (): Promise<void> => undefined),
  }
})
const startup = vi.hoisted(() => ({ home: '/tmp/score-test-startup' }))

vi.mock('../src/domain/spend.ts', () => ({ snapshotSessionCosts: mocks.snapshotSessionCosts }))

vi.mock('../src/domain/approval-outbox.ts', () => ({
  ApprovalOutbox: class {
    constructor() {
      return mocks.outbox
    }
  },
}))
vi.mock('../src/db/index.ts', () => ({
  openDatabase: mocks.openDatabase,
  migrate: mocks.migrate,
  acquireHomeLock: mocks.acquireHomeLock,
  getEpoch: mocks.getEpoch,
  resetEpoch: vi.fn(),
}))
vi.mock('../src/hub/ingest.ts', () => ({ createIngest: mocks.createIngest }))
vi.mock('../src/hermes/index.ts', () => ({
  createHermesPort: mocks.createHermesPort,
  loadBridgeBootstrap: mocks.loadBridgeBootstrap,
  pruneBridge: mocks.pruneBridge,
  kanbanAttemptsEnabled: () => false,
  pruneKanbanAttempts: () => ({ pages: 0, seenEvents: 0 }),
  createScreenshotImporter: mocks.createScreenshotImporter,
  sweepKanbanDenials: mocks.sweepKanbanDenials,
  RewindBroker: class {},
  FakePort: class {},
  attachFakeLead: vi.fn(),
  resolveHermesHome: () => `${startup.home}/hermes-home`,
}))
vi.mock('../src/hub/retention.ts', () => ({ pruneEvents: mocks.pruneEvents }))
vi.mock('../src/db/fts.ts', () => ({ ensureMessageFts: vi.fn() }))
vi.mock('../src/hub/retention-aux.ts', () => ({ pruneAuxiliary: vi.fn() }))
vi.mock('../src/hub/retire.ts', () => ({ retireIngestKeys: mocks.retireIngestKeys }))
vi.mock('../src/knowledge/vault.ts', () => ({
  KnowledgeVault: class {
    start = async () => undefined
    close = async () => undefined
  },
}))
vi.mock('../src/app.ts', () => ({ buildApp: mocks.buildApp }))
// The orchestration executor has its own tests (test/orchestration); startup only needs it to exist.
vi.mock('../src/domain/orchestration/executor.ts', () => ({
  Orchestrator: class {
    start = async () => undefined
    close = async () => undefined
  },
}))
vi.mock('../src/domain/orchestration/fence.ts', () => ({
  isFenced: () => false,
  fenceItems: () => [],
  GlobalFenceStore: class {
    startupCheck = () => ({ fenced: false, reasons: [] })
    fenceUnverifiedRoot = () => false
    setHardBlock = () => undefined
    setCopiedFrom = () => undefined
    frozenNotice = () => null
  },
}))
// Installation identity and the journal migration have their own tests (installation, orchestration/journal-migration).
vi.mock('../src/installation.ts', () => ({
  resolveInstallation: () => ({
    ok: true,
    id: '0123456789abcdef',
    namespaceDir: `${startup.home}-ns`,
    how: 'created',
  }),
}))
vi.mock('../src/domain/orchestration/journal-migration.ts', () => ({
  migrateLegacyJournal: () => ({ ok: true, state: 'none', copied: 0 }),
}))
vi.mock('../src/domain/orchestration/journal.ts', () => ({
  ExecutionJournal: class {
    // The coding runtime's fallback recovery reads its own records at start (7.7a FX2).
    readOwn = () => []
  },
  journalScope: () => 'scope',
}))
vi.mock('../src/auth/sqlite-session-store.ts', () => ({
  SqliteSessionStore: class {
    constructor(db: unknown) {
      mocks.storeConstructor(db)
    }
  },
}))

export let signals: Map<string | symbol, () => void>
let previousExitCode: typeof process.exitCode

export function setupStartup(feature: string): string {
  const home = `/tmp/score-test-startup-${feature}`
  startup.home = home

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.createIngest.mockReturnValue(mocks.ingest)
    mocks.createHermesPort.mockReturnValue(mocks.port)
    vi.spyOn(globalThis, 'setInterval')
    previousExitCode = process.exitCode
    process.exitCode = undefined
    vi.stubEnv('SCORE_HOME', home)
    // Live starts record the journal root in the home; each file's fixed home must not carry one from an earlier run
    // (it would name another state folder and correctly refuse the start).
    rmSync(`${home}/journal-root`, { force: true })
    vi.stubEnv('SCORE_VAULT', `${home}/vault`) // the vault is mocked here; no temp folder
    vi.stubEnv('SCORE_PORT', '8740')
    vi.stubEnv('SCORE_HOST', '127.0.0.1')
    vi.stubEnv('SCORE_WEB_ORIGIN', 'http://127.0.0.1:5173')
    vi.stubEnv('SCORE_MODE', 'fake')
    signals = new Map()
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      signals.set(event, listener)
      return process
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    // The pairing link is printed only to a terminal (anything else, like the launcher's log, never gets it).
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    for (const result of vi.mocked(setInterval).mock.results) {
      if (result.type === 'return') clearInterval(result.value)
    }
    vi.useRealTimers()
    Reflect.deleteProperty(process.stdout, 'isTTY')
    process.exitCode = previousExitCode
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  return home
}

// Exported separately: Vitest does not allow `export const x = vi.hoisted(...)`.
export { mocks }

import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSecureContext, type SecureContextOptions, type TlsOptions } from 'node:tls'
import type { FastifyInstance } from 'fastify'
import { buildApp, buildBridgeApp } from './app.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import { resolveJournalDir, type Config } from './config.ts'
import { getEpoch } from './db/index.ts'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { CodingJournal } from './domain/orchestration/coding-journal.ts'
import { Orchestrator } from './domain/orchestration/executor.ts'
import { GlobalFenceStore } from './domain/orchestration/fence.ts'
import { ExecutionJournal, journalScope } from './domain/orchestration/journal.ts'
import { ensureTeamRoom } from './domain/team-room.ts'
import { listenDual } from './dual-listener.ts'
import {
  attachFakeLead,
  createHermesPort,
  createScreenshotImporter,
  FakePort,
  loadBridgeBootstrap,
  resolveHermesHome,
  RewindBroker,
  seedFakeTeam,
} from './hermes/index.ts'
import { buildGuideApp } from './http/https-guide.ts'
import { loadWebAssets, type WebAssets } from './http/web-assets.ts'
import { KnowledgeAgentApi } from './knowledge/agent-api.ts'
import { KnowledgeVault } from './knowledge/vault.ts'
import { McpAccessStore } from './mcp/access.ts'
import { MediaStore } from './media/store.ts'
import { CodingRuntime } from './runtimes/coding/service.ts'
import { locatorForMode } from './runtimes/coding/cli.ts'
import { fallbackForced, fenceBarrier, UnitBackend } from './runtimes/coding/unit-backend.ts'
import { makeCheckSpawner } from './runtimes/check/spawn-check.ts'
import { withCodingAgents } from './runtimes/coding/port.ts'
import { startBackgroundServices, startHoldRecovery } from './start-server-background.ts'
import { ServerLifecycle } from './start-server-lifecycle.ts'
import { INSECURE_FLAG_REMOVED, type StartServerOptions } from './start-server-options.ts'
import { initializeScoreState, realHome } from './start-server-state.ts'
import { namedCertificates } from './tls-names.ts'
import { defaultRootPolicy } from './workspace/policy.ts'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

export { startGuideServer } from './start-server-guide.ts'

/** Stands in for the installation id while it is unresolved: the backend is disabled and launches nothing. */
const UNRESOLVED_INSTALLATION = '00000000-0000-4000-8000-000000000000'

export async function startServer(
  config: Config,
  { logger, listen, listenBridge, webDirectory }: StartServerOptions = {},
) {
  let https: (SecureContextOptions & Pick<TlsOptions, 'SNICallback'>) | undefined
  let webAssets: WebAssets | undefined
  // Validate transport and the build before opening Score state or starting the adapter.
  if (config.remote) {
    if (config.remote.tlsCert && config.remote.tlsKey) {
      https = { cert: readFileSync(config.remote.tlsCert), key: readFileSync(config.remote.tlsKey) }
      createSecureContext(https)
      if (config.remote.tlsNamesDir)
        https.SNICallback = namedCertificates(config.remote.tlsNamesDir).sniCallback
    }
  }
  if (config.remote || config.serveWeb)
    webAssets = loadWebAssets(
      webDirectory ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    )
  let app: FastifyInstance | undefined
  let bridgeApp: FastifyInstance | undefined
  const lifecycle = new ServerLifecycle()
  const close = () => lifecycle.close()
  try {
    const { rootProvenance, installation, installationBlock, database, ingest } =
      initializeScoreState(
        config,
        (homeLock) => {
          lifecycle.homeLock = homeLock
        },
        (opened) => {
          lifecycle.db = opened
        },
      )
    lifecycle.ingest = ingest
    const media = new MediaStore(database, join(config.home, 'media'), {
      ...(config.mediaQuotaMb ? { quotaBytes: config.mediaQuotaMb * 1024 * 1024 } : {}),
    })
    // Session rewinds (5.33): the live port asks, the bridge routes hand the command to the plugin.
    const rewindBroker = new RewindBroker()
    // The fence store exists a few lines further down; the port only asks once it is started.
    let holding: () => string | null = () => null
    const port = createHermesPort(config, {
      frozen: () => holding(),
      db: database,
      rewindBroker,
      imageReader: (id) => media.read(id),
      onError: (error) => app?.log.error({ err: error }, 'Hermes observation failed'),
    })
    lifecycle.port = port
    const adapter = port
    // Orchestrations (PLAN 7.5a): the execution journal lives outside the home; every start compares it with the
    // database and fences admission when they disagree (design v3).
    // Per-installation namespace (7.7a §2); while the installation is unresolved the legacy path is only read (its
    // writers are refused after a cutover) and the hard block keeps the fence up.
    const journal =
      installation?.ok && installationBlock === null
        ? new ExecutionJournal(installation.namespaceDir, installation.id)
        : new ExecutionJournal(resolveJournalDir(config), journalScope(realHome(config.home)))
    const fenceStore = new GlobalFenceStore(database, journal)
    fenceStore.setHardBlock(installationBlock)
    fenceStore.setCopiedFrom(installation?.ok ? installation.copiedFrom : undefined)
    holding = () => fenceStore.frozenNotice()
    const fenced = fenceStore.startupCheck()
    if (rootProvenance && rootProvenance.state !== 'known') {
      const why =
        rootProvenance.state === 'corrupt'
          ? `The journal-root record outside the home is unreadable (${rootProvenance.reason})`
          : rootProvenance.state === 'missing'
            ? 'No journal-root record exists outside the home'
            : "The journal-root record outside the home doesn't list this home"
      if (
        fenceStore.fenceUnverifiedRoot(why) &&
        !fenced.reasons.includes('journal_root_unverified')
      )
        fenced.reasons.push('journal_root_unverified')
    }
    if (fenced.reasons.length > 0)
      process.stderr.write(
        `Orchestration admission is fenced (${fenced.reasons.join(', ')}): review the reconciliation list in Score before lifting it.\n`,
      )
    // Coding agents (PLAN 7.2): fake mode never starts a real CLI (see locatorForMode).
    const { hermesHome: runtimeHome } = config
    // Coding backend (7.7a). Live mode always gets a UnitBackend: it owns the admission barriers (fences, orphan units,
    // held launches) and the reconciliation of both inventories, whichever backend launches. Whether runs are
    // *supervised* is decided by the capability check; a forced fallback, a missing runtime directory or an unresolved
    // installation only mark the backend disabled (review #5).
    const runtimeDir = process.env.XDG_RUNTIME_DIR
    const forcedFallback = fallbackForced(process.env)
    const disabled =
      installation?.ok !== true || installationBlock !== null
        ? (installationBlock ?? 'This installation isn’t resolved yet.')
        : !runtimeDir
          ? 'There is no user runtime folder ($XDG_RUNTIME_DIR).'
          : forcedFallback
            ? 'The fallback is forced (SCORE_CODING_BACKEND).'
            : undefined
    const resolved = installation?.ok === true ? installation : undefined
    const codingJournal = new CodingJournal(journal, () => database.sqlite.isTransaction)
    let orchestrator: Orchestrator | undefined = undefined
    const unit =
      config.mode === 'live'
        ? new UnitBackend({
            db: database,
            journal: codingJournal,
            installationId: resolved?.id ?? UNRESOLVED_INSTALLATION,
            namespaceDir: resolved?.namespaceDir ?? resolveJournalDir(config),
            runtimeDir: runtimeDir ?? tmpdir(),
            home: homedir(),
            ...(disabled !== undefined ? { disabled } : {}),
            ...(resolved === undefined || installationBlock !== null ? { unresolved: true } : {}),
            // Restore, journal and installation uncertainty stop every coding launch, whichever engine runs it.
            blocked: () => installationBlock ?? database.read((sqlite) => fenceBarrier(sqlite)),
            frozen: () => fenceStore.frozenNotice(),
            onEnded: () => orchestrator?.kick(),
            ...(forcedFallback ? { forced: true } : {}),
            onError: (error) => app?.log.error({ err: error }, 'Coding unit backend failed'),
          })
        : undefined
    if (unit) {
      const status = await unit.start()
      process.stderr.write(
        `Coding runs: ${
          status.kind === 'unit' && status.checks.some((c) => !c.ok)
            ? `paused (${status.note})`
            : status.kind === 'unit'
              ? 'supervised system services'
              : `process-group fallback (${status.checks
                  .filter((c) => !c.ok)
                  .map((c) => c.detail)
                  .join('; ')})`
        }\n`,
      )
    }
    const coding = new CodingRuntime({
      db: database,
      ingest,
      ...(unit ? { unit } : {}),
      // Frozen homes (unresolved or copied installation, lost journal) admit and signal nothing (decision 71); beyond that
      // a process row an inherited launch covers is never ours, and an unreadable history owns nothing.
      frozen: () => fenceStore.frozenNotice(),
      ...(config.mode === 'live'
        ? {
            ownsProcessRow: (runId: string) =>
              resolved !== undefined &&
              installationBlock === null &&
              codingJournal.ownsProcessRow(runId),
          }
        : {}),
      onOrphans: (names) =>
        fenceStore.set(
          'A coding service Score can’t account for is running',
          names.map((name) => ({
            kind: 'journal' as const,
            ref: `coding-unit:${name}`,
            journalN: null,
            detail: `The service ${name} carries this installation’s prefix but no journal launch owns it.`,
          })),
        ),
      locator: locatorForMode(config.mode, process.env),
      home: config.home,
      policy: defaultRootPolicy([config.home, resolveHermesHome(runtimeHome), resolveHermesHome()]),
      onError: (error) => app?.log.error({ err: error }, 'Coding agent run failed'),
    })
    lifecycle.coding = coding
    // A CLI child dies with Score: turns still marked running are interrupted before anything else runs.
    await coding.recover()
    // The composite port (Hermes agents plus coding agents) is built once and shared by the routes and the executor
    // (7.7b §2): a step for a coding agent must reach the coding runtime, never Hermes.
    const composite = withCodingAgents(port, coding)
    const codingRuntime = coding
    const executor = new Orchestrator({
      db: database,
      ingest,
      port: composite,
      access: new McpAccessStore(database),
      fence: fenceStore,
      codingFacts: codingRuntime.workerFacts(),
      // 3.13: the oracle runs only in folders the Workspace tab would allow (never Score's or Hermes's homes).
      checks: makeCheckSpawner(
        defaultRootPolicy([config.home, resolveHermesHome(runtimeHome), resolveHermesHome()]),
      ),
      mcpAvailable: Boolean(config.remote),
      onError: (error) => app?.log.error({ err: error }, 'Orchestration executor failed'),
    })
    orchestrator = executor
    lifecycle.orchestrator = executor
    // The fake adapter has no models: a scripted lead stands in (it calls the same tools in-process).
    if (config.mode === 'fake' && port instanceof FakePort) attachFakeLead(port, executor)
    const outbox = new ApprovalOutbox({
      db: database,
      ingest,
      port,
      onError: (error) => app?.log.error({ err: error }, 'Approval delivery failed'),
    })
    lifecycle.outbox = outbox
    const liveBridge =
      config.mode === 'live'
        ? {
            db: database,
            ingest,
            bootstrapHash: loadBridgeBootstrap(config.home),
            getCompatibility: () => adapter.status().compatibility,
            importScreenshot: createScreenshotImporter(config, media),
            rewind: rewindBroker,
          }
        : undefined
    // Fake mode (tests, e2e, demos) gets a throwaway seeded vault unless SCORE_VAULT names one.
    let fakeVaultDir: string | undefined
    if (config.mode === 'fake' && !config.vault) {
      fakeVaultDir = mkdtempSync(join(tmpdir(), 'score-fake-vault-'))
      lifecycle.fakeVaultDir = fakeVaultDir
    }
    const knowledgeIngest = ingest
    let knowledge: KnowledgeVault | undefined = new KnowledgeVault({
      vault: config.vault ?? fakeVaultDir ?? join(homedir(), 'score-vault'),
      db: database,
      emit: (change) =>
        knowledgeIngest.submit({
          source: 'knowledge',
          identity: randomUUID(),
          apply: () => [{ type: 'knowledge.changed', data: change }],
        }),
      log: { warn: (object, message) => app?.log.warn(object, message) },
      seed: fakeVaultDir !== undefined,
      stateDir: join(config.home, 'knowledge'),
    })
    lifecycle.knowledge = knowledge
    try {
      await knowledge.start()
    } catch (error) {
      // A vault that cannot be created (permissions, read-only disk) must not stop the rest of Score.
      process.stderr.write(`Knowledge is unavailable: ${String(error)}\n`)
      await knowledge.close()
      knowledge = undefined
      lifecycle.knowledge = undefined
    }
    const bridge =
      liveBridge && knowledge
        ? { ...liveBridge, knowledge: new KnowledgeAgentApi(knowledge, database) }
        : liveBridge
    app = buildApp({
      config,
      port: composite,
      coding,
      ...(knowledge ? { knowledge } : {}),
      outbox,
      media,
      orchestrator: executor,
      ...(logger === undefined ? {} : { logger }),
      db: database,
      ingest,
      getEpoch: () => getEpoch(database),
      sessionStore: new SqliteSessionStore(database),
      ...(bridge ? { bridge } : {}),
      ...(https ? { https } : {}),
      ...(webAssets ? { webAssets } : {}),
    })
    lifecycle.app = app
    const token = app.pairing.createToken()
    if (config.remote) {
      bridgeApp = buildBridgeApp(
        bridge,
        outbox,
        logger ?? false,
        // The MCP server for agents (7.4d) is served on this loopback listener only.
        {
          db: database,
          access: new McpAccessStore(database),
          ingest,
          port,
          orchestrator: executor,
          ...(knowledge ? { knowledge: new KnowledgeAgentApi(knowledge, database) } : {}),
        },
      )
      lifecycle.bridgeApp = bridgeApp
      try {
        if (listenBridge) await listenBridge(bridgeApp)
        else await bridgeApp.listen({ host: '127.0.0.1', port: config.remote.bridgePort })
      } catch (error) {
        throw new Error('Could not bind the loopback bridge listener', { cause: error })
      }
    }
    if (config.ignoredInsecureHttp) app.log.warn(INSECURE_FLAG_REMOVED)
    try {
      if (listen) await listen(app)
      else if (config.remote) {
        // One port, both protocols: TLS goes to the app, plain HTTP gets the setup guide.
        const guideApp = buildGuideApp(config, logger ?? false)
        lifecycle.guideApp = guideApp
        lifecycle.dualServer = await listenDual(app, guideApp, {
          host: config.host,
          port: config.port,
        })
      } else await app.listen({ host: config.host, port: config.port })
    } catch (error) {
      if (!config.remote) throw error
      throw new Error('Could not bind the browser listener', { cause: error })
    }
    await port.start(ingest)
    // Only now can runs be started or stopped: recover unfinished attempts, then work event-driven.
    await executor.start()
    startHoldRecovery(app, lifecycle)
    // Warm the per-profile caches, so the first page load after a restart doesn't wait ~15 s on cold Hermes reads.
    const warming = coding ? withCodingAgents(port, coding) : port
    const teamIngest = ingest
    const warmTeam = Promise.resolve()
      .then(() => warming.listAgents())
      // The team room of the new shell (PLAN 11.1b) exists once the team's agents are known.
      .then(async (agents) => {
        await teamIngest.submit({
          source: 'rooms',
          identity: randomUUID(),
          apply: ({ sqlite, now }) =>
            ensureTeamRoom(
              sqlite,
              agents.map((agent) => agent.id),
              now,
            ),
        })
        // The fake adapter's seeded team room (PLAN 11.2c), once the room exists.
        if (config.mode === 'fake') seedFakeTeam(database.sqlite)
      })
      .catch(() => undefined)
    // Fake mode's boards load straight after start, so wait for the seed; live warming stays off the startup path.
    if (config.mode === 'fake') await warmTeam
    await outbox.start()
    startBackgroundServices({ config, app, db: database, ingest, outbox, port, lifecycle })
    return {
      app,
      bridgeApp,
      pairingToken: token,
      orchestrator: executor,
      port: composite,
      ingest,
      db: database,
      installation: installationBlock === null ? installation : undefined,
      close,
    }
  } catch (error) {
    try {
      await close()
    } catch (closeError) {
      app?.log.error({ err: closeError }, 'Startup cleanup failed')
    }
    throw error
  }
}

import { ORCH_ACKNOWLEDGEMENT_TEXT, type OrchestrationCreate } from '@score/contract'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deriveAgentStatusEvents } from '../../src/domain/agent-status.ts'
import { deriveBriefEvents } from '../../src/domain/briefs.ts'
import { deriveTaskEvents } from '../../src/domain/tasks.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { Orchestrator, type OrchestratorOptions } from '../../src/domain/orchestration/executor.ts'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { attachFakeLead, type FakeLeadOptions } from '../../src/hermes/fake/fake-lead.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import type { HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
import { CliLocator } from '../../src/runtimes/coding/cli.ts'
import { withCodingAgents } from '../../src/runtimes/coding/port.ts'
import { CodingRuntime, type CodingRuntimeDeps } from '../../src/runtimes/coding/service.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import { processStart } from '../../src/runtimes/coding/proc.ts'
import {
  fenceBarrier,
  UnitBackend,
  type UnitBackendDeps,
} from '../../src/runtimes/coding/unit-backend.ts'
import { defaultRootPolicy } from '../../src/workspace/policy.ts'
import { FAKE_CLI } from '../runtimes/coding-fixtures.ts'
import { FakeSystemd } from './fake-systemd.ts'

// 7.7b: the real Orchestrator on the composite port, the real CodingRuntime and UnitBackend (real supervisor, Score
// socket and journal), a scripted Hermes lead and a harmless fake CLI. Only systemd is faked (test/helpers/fake-systemd).
// Nothing here starts a real unit, a real CLI or a model.

export const INSTALLATION = 'abcdef0123456789'

export interface WorkerHarnessOptions {
  lead?: FakeLeadOptions
  orchestrator?: Partial<OrchestratorOptions>
  unit?: Partial<UnitBackendDeps>
  coding?: Partial<CodingRuntimeDeps>
  maxTurnMs?: number
  graceMs?: number
}

export interface WorkerHarness {
  dir: string
  home: string
  workspace: string
  /** The fake CLI as this test's own copy (its identity is the CLI's identity: a test may replace it). */
  cliFile: string
  /** The environment the CLI would be started from (the locator's input): a test may change an allow-listed variable. */
  cliEnv: Record<string, string | undefined>
  namespace: string
  db: ScoreDb
  ingest: Ingest
  raw: FakePort
  port: HermesPort
  fake: FakeSystemd
  journal: ExecutionJournal
  fence: GlobalFenceStore
  orch: Orchestrator
  coding: CodingRuntime
  backend: UnitBackend
  errors: unknown[]
  /** Starts every layer again on the same database, journal and fake systemd (a Score restart). */
  restart(options?: { beforeStart?: () => void | Promise<void> }): Promise<void>
  /** Stops the runtime layers without starting them again (the process is "down"). */
  stop(): Promise<void>
  addAgent(id?: string, runtime?: 'claude-code' | 'codex', permission?: string): void
  create(overrides?: Partial<OrchestrationCreate>): Promise<string>
  /** Polls (real time) until `done()` holds. */
  until(done: () => boolean, timeoutMs?: number): Promise<void>
  rows<T = Record<string, unknown>>(sql: string, ...args: (string | number)[]): T[]
  /** The fake CLI's own log: one entry per CLI process that really started. */
  cliCalls(): { runtime: string; args: string[]; prompt: string }[]
  close(): Promise<void>
}

export async function workerHarness(options: WorkerHarnessOptions = {}): Promise<WorkerHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'score-w7-'))
  const home = join(dir, 'home')
  const workspace = join(dir, 'ws')
  const namespace = join(dir, 'journal', INSTALLATION)
  const runtimeDir = join(dir, 'rt')
  mkdirSync(home)
  mkdirSync(workspace)
  mkdirSync(runtimeDir, { mode: 0o700 })
  mkdirSync(namespace, { recursive: true })
  mkdirSync(join(namespace, 'launches'))
  // The fake CLI and its fixtures are copied, so replacing "the CLI" in one test touches nothing another test runs.
  const cliDir = join(dir, 'cli')
  cpSync(dirname(FAKE_CLI), cliDir, { recursive: true })
  const cliFile = join(cliDir, 'fake-cli.mjs')
  const cliEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
  }
  const previousFake = process.env['SCORE_CODING_FAKE_LOG']
  process.env['SCORE_CODING_FAKE_LOG'] = join(dir, 'fake-cli.log')
  cliEnv['SCORE_CODING_FAKE_LOG'] = join(dir, 'fake-cli.log')
  const fake = new FakeSystemd()
  const db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const journal = new ExecutionJournal(namespace, INSTALLATION)
  const ingest = createIngest(db, {
    deriveEvents: (sqlite, drafts, context) => [
      ...deriveTaskEvents(sqlite, drafts, context),
      ...deriveBriefEvents(sqlite, drafts, context),
      ...deriveAgentStatusEvents(sqlite, drafts, context),
    ],
  })
  const raw = new FakePort(100, { db }, false)
  await raw.start(ingest)
  const errors: unknown[] = []
  const fence = new GlobalFenceStore(db, journal)
  fence.startupCheck()

  const self = {} as WorkerHarness
  Object.assign(self, {
    dir,
    home,
    workspace,
    namespace,
    cliFile,
    cliEnv,
    db,
    ingest,
    raw,
    fake,
    journal,
    fence,
    errors,
  })

  async function boot(): Promise<void> {
    const backend = new UnitBackend({
      db,
      journal: new CodingJournal(journal, () => db.sqlite.isTransaction),
      installationId: INSTALLATION,
      namespaceDir: namespace,
      runtimeDir,
      home,
      run: fake.run,
      population: fake.population,
      proc: {
        start: (pid) => fake.procStart(pid) ?? processStart(pid),
        cgroup: (_pid, claimed) => claimed,
        boot: () => fake.boot,
      },
      manager: async () => ({ pid: fake.managerPid, start: '1000' }),
      signalSupervisor: fake.signal,
      notifySocket: join(runtimeDir, 'notify'),
      notifyBin: null,
      specOverrides: { tickMs: 50, pollMs: 20 },
      pollMs: 20,
      readyTimeoutMs: 10_000,
      proofTimeoutMs: 15_000,
      graceMs: options.graceMs ?? 300,
      blocked: () => db.read((sqlite) => fenceBarrier(sqlite)),
      onError: (error) => errors.push(error),
      onEnded: () => self.orch?.kick(),
      frozen: () => fence.frozenNotice(),
      ...options.unit,
    })
    await backend.start()
    const coding = new CodingRuntime({
      db,
      ingest,
      locator: new CliLocator({
        fakeCli: cliFile,
        cacheMs: 0,
        // The CLIs' configuration folders are this test's own (their files are only ever stat'ed).
        env: cliEnv,
      }),
      home,
      policy: defaultRootPolicy([home]),
      maxTurnMs: options.maxTurnMs ?? 60_000,
      graceMs: options.graceMs ?? 300,
      terminalRetryMs: 10,
      stopObserveMs: 2_000,
      reapRetryMs: 100,
      unit: backend,
      onError: (error) => errors.push(error),
      frozen: () => fence.frozenNotice(),
      ...options.coding,
    })
    await coding.recover()
    const composite = withCodingAgents(raw, coding)
    const orch = new Orchestrator({
      db,
      ingest,
      port: composite,
      access: new McpAccessStore(db),
      fence,
      retryMs: 100,
      codingFacts: coding.workerFacts(),
      onError: (error) => errors.push(error),
      ...options.orchestrator,
    })
    attachFakeLead(raw, orch, options.lead)
    Object.assign(self, { backend, coding, orch, port: composite })
    await orch.start()
  }

  async function stop(): Promise<void> {
    await self.orch?.close()
    await self.coding?.close()
  }

  Object.assign(self, {
    async restart(restartOptions?: { beforeStart?: () => void | Promise<void> }) {
      await stop()
      await restartOptions?.beforeStart?.()
      fence.startupCheck()
      await boot()
    },
    stop,
    addAgent(
      id = 'coder',
      runtime: 'claude-code' | 'codex' = 'claude-code',
      permission = 'workspace-write',
    ) {
      insertCodingAgent(db.sqlite, {
        id,
        name: id,
        role: '',
        runtime,
        workspace,
        permission: permission as 'workspace-write',
        model: null,
        style: { color: '#19C39A', shape: 'hexagon' },
        createdAt: new Date().toISOString(),
      })
    },
    async create(overrides: Partial<OrchestrationCreate> = {}) {
      // The person looks at preflight and approves what it shows: the policy ids, and the reach where it goes beyond.
      const preflight = await self.orch.preflight(
        overrides.leadAgentId ?? 'lead',
        overrides.allowedAgents ?? ['coder'],
      )
      const policies = preflight.workers.flatMap((worker) =>
        worker.policyId === null ? [] : [[worker.agentId, worker.policyId] as const],
      )
      const created = await self.orch.create({
        codingPolicies: Object.fromEntries(policies),
        acknowledgeCodingReach: {
          policyIds: preflight.workers.flatMap((worker) =>
            worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
          ),
        },
        goal: 'Write the release notes',
        leadAgentId: 'lead',
        allowedAgents: ['coder'],
        gatePolicy: 'none',
        advisorMode: 'on_call',
        maxSteps: 12,
        maxLeadTurns: 20,
        maxConcurrentSteps: 2,
        leadTurnEstimateUsd: 0.25,
        stepEstimateUsd: 0.5,
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
        ...overrides,
      })
      return created.orchestration.id
    },
    async until(done: () => boolean, timeoutMs = 30_000) {
      await vi.waitFor(() => expect(done(), `waiting for: ${done.toString()}`).toBe(true), {
        timeout: timeoutMs,
        interval: 50,
      })
    },
    cliCalls() {
      const path = join(dir, 'fake-cli.log')
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { runtime: string; args: string[]; prompt: string })
        : []
    },
    rows(sql: string, ...args: (string | number)[]) {
      return db.sqlite.prepare(sql).all(...args) as never
    },
    async close() {
      // A unit a test kept populated would keep the runtime waiting for its proof for ever.
      for (const unit of fake.units.values()) unit.forcePopulated = false
      await stop().catch(() => undefined)
      await fake.cleanup()
      await raw.stop()
      await ingest.close()
      db.close()
      if (previousFake === undefined) delete process.env['SCORE_CODING_FAKE_LOG']
      else process.env['SCORE_CODING_FAKE_LOG'] = previousFake
      rmSync(dir, { recursive: true, force: true })
    },
  })
  await boot()
  return self
}

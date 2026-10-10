import { ORCH_ACKNOWLEDGEMENT_TEXT, type OrchestrationCreate } from '@score/contract'
import { join } from 'node:path'
import { deriveAgentStatusEvents } from '../../src/domain/agent-status.ts'
import { deriveBriefEvents } from '../../src/domain/briefs.ts'
import { deriveTaskEvents } from '../../src/domain/tasks.ts'
import { Orchestrator, type OrchestratorOptions } from '../../src/domain/orchestration/executor.ts'
import { GlobalFenceStore } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { attachFakeLead, type FakeLeadOptions } from '../../src/hermes/fake/fake-lead.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { McpAccessStore } from '../../src/mcp/access.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { openMigrated, tempDir } from './harness-db.ts'
import type { ScoreDb } from '../../src/db/index.ts'

export interface Harness {
  dir: string
  db: ScoreDb
  ingest: Ingest
  port: FakePort
  scheduler: FakeScheduler
  orch: Orchestrator
  fence: GlobalFenceStore
  journal: ExecutionJournal
  access: McpAccessStore
  journalDir: string
  /** Advances virtual time and lets the executor work until `done()` (or the budget is spent). */
  until(done: () => boolean, maxMs?: number): Promise<void>
  /** Lets everything that is ready run. */
  settle(ms?: number): Promise<void>
  create(overrides?: Partial<OrchestrationCreate>): Promise<string>
  close(): Promise<void>
  rows<T = Record<string, unknown>>(sql: string, ...args: (string | number)[]): T[]
}

export const create = (overrides: Partial<OrchestrationCreate> = {}): OrchestrationCreate => ({
  goal: 'Write the release notes',
  leadAgentId: 'lead',
  allowedAgents: ['builder', 'reviewer'],
  gatePolicy: 'none',
  maxSteps: 12,
  maxLeadTurns: 20,
  maxConcurrentSteps: 2,
  leadTurnEstimateUsd: 0.25,
  stepEstimateUsd: 0.5,
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
  ...overrides,
})

export async function harness(
  options: {
    lead?: FakeLeadOptions
    orchestrator?: Partial<OrchestratorOptions>
    journalDir?: string
    reply?: (req: { agentId: string; input: string }) => { text: string; tools: string[] }
    dir?: string
    scope?: string
  } = {},
): Promise<Harness> {
  const tmp = options.dir ? { dir: options.dir, cleanup: () => undefined } : tempDir('orc-')
  const dir = tmp.dir
  const db = openMigrated(dir)
  const scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  const ingest = createIngest(db, {
    clock,
    deriveEvents: (sqlite, drafts, context) => [
      ...deriveTaskEvents(sqlite, drafts, context),
      ...deriveBriefEvents(sqlite, drafts, context),
      ...deriveAgentStatusEvents(sqlite, drafts, context),
    ],
  })
  const port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: options.reply?.(req).text ?? 'The step is done.',
    tools: options.reply?.(req).tools ?? [],
  }))
  await port.start(ingest)
  scheduler.clearTimeout(0)
  const journalDir = options.journalDir ?? join(dir, 'journal')
  const journal = new ExecutionJournal(journalDir, options.scope ?? 'test-home', clock)
  const fence = new GlobalFenceStore(db, journal, clock)
  fence.startupCheck()
  const access = new McpAccessStore(db, clock)
  const orch = new Orchestrator({ db, ingest, port, access, fence, clock, retryMs: 1000, ...options.orchestrator })
  attachFakeLead(port, orch, options.lead)
  await orch.start()
  const self: Harness = {
    dir,
    db,
    ingest,
    port,
    scheduler,
    orch,
    fence,
    journal,
    access,
    journalDir,
    async settle(ms = 300) {
      await scheduler.advance(ms)
      await ingest.flushListeners()
      await ingest.drain()
      await orch.idle()
    },
    async until(done, maxMs = 120_000) {
      for (let spent = 0; spent < maxMs; spent += 300) {
        if (done()) return
        await self.settle(300)
      }
      if (!done()) throw new Error('Condition not reached')
    },
    async create(overrides) {
      const created = await orch.create(create(overrides))
      return created.orchestration.id
    },
    async close() {
      await orch.close()
      await port.stop()
      await ingest.close()
      db.close()
      tmp.cleanup()
    },
    rows(sql, ...args) {
      return db.sqlite.prepare(sql).all(...args) as never
    },
  }
  return self
}

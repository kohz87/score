import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../../db/index.ts'
import type { Ingest } from '../../hub/ingest.ts'
import type { CheckProcess } from '../../runtimes/check/spawn-check.ts'
import { makeSpendReader, type SpendReader } from './budget.ts'
import { quotaUsed } from './executor-capacity.ts'
import { installExecutorMethods, type OrchestratorPublicMethods } from './executor-runtime.ts'
import { ORCHESTRATION_QUOTA_BYTES, type OrchestratorOptions } from './executor-types.ts'

export { ORCHESTRATION_QUOTA_BYTES } from './executor-types.ts'
export type { OrchestratorOptions, ReleaseChecks, ReleaseSubject } from './executor-types.ts'

/**
 * The orchestration executor: the single admission authority for lead attempts and steps (design v3). All writes go
 * through `mutate`, one ingest transaction each, so events, revisions and the database stay consistent.
 */
const OrchestratorCore = class Orchestrator {
  private readonly db: ScoreDb
  private readonly ingest: Ingest
  private readonly clock: () => number
  private readonly spend: SpendReader
  private readonly quotaBytes: number
  private readonly retryMs: number
  /** Whether this adapter can prove a session's compression lineage is complete (only the fake one can). */
  private readonly lineageProvable: boolean
  private pumping: Promise<void> | undefined
  private again = false
  private closed = false
  private timer: NodeJS.Timeout | undefined
  private maintenanceTimer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private readonly cooldown = new Map<string, number>()
  private readonly stopTried = new Map<string, { at: number; delay: number; fails: number }>()
  /** In-flight Stop deliveries, one per attempt (design §9). */
  private readonly stopJobs = new Map<string, Promise<void>>()
  private abandonStops = false
  private readonly fingerprints = new Map<string, string>()
  private readonly ownershipSeen = new Map<string, string>()
  private readonly served = new Map<string, boolean>()
  /** 3.13: check runs in flight, by check id. */
  private readonly checkJobs = new Map<string, { orchId: string; proc: CheckProcess }>()
  /** Check ids between "marked running" and "recorded": a running row outside this set is stuck (review P2). */
  private readonly checksInFlight = new Set<string>()
  private readonly resetWakes = new Set<string>()

  constructor(private readonly options: OrchestratorOptions) {
    this.db = options.db
    this.ingest = options.ingest
    this.clock = options.clock ?? Date.now
    this.spend = options.spend ?? makeSpendReader(options.port.mode !== 'fake')
    this.quotaBytes = options.quotaBytes ?? ORCHESTRATION_QUOTA_BYTES
    this.retryMs = options.retryMs ?? 5_000
    this.lineageProvable = options.port.mode === 'fake'
    options.fence.onChange = () => (this as unknown as { announceFence(): void }).announceFence()
  }

  /** Whether the whole database still has storage for `extra` more reserved bytes (a coding limit that grows a reserve). */
  private readonly storageFits = (sqlite: DatabaseSync, extra: number): boolean =>
    quotaUsed(sqlite) + extra <= this.quotaBytes
}

installExecutorMethods(OrchestratorCore.prototype)

export type Orchestrator = InstanceType<typeof OrchestratorCore> & OrchestratorPublicMethods

type OrchestratorConstructor = {
  new (options: OrchestratorOptions): Orchestrator
  readonly prototype: Orchestrator
}

export const Orchestrator = OrchestratorCore as unknown as OrchestratorConstructor

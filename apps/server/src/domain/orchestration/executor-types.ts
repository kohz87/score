import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPort } from '../../hermes/index.ts'
import type { Ingest } from '../../hub/ingest.ts'
import type { McpAccessStore } from '../../mcp/access.ts'
import type { CheckSpawner } from '../../runtimes/check/spawn-check.ts'
import type { SpendReader } from './budget.ts'
import type { GlobalFenceStore } from './fence.ts'
import type { CodingWorkerFacts } from './supported-agents.ts'

export const ORCHESTRATION_QUOTA_BYTES = 200 * 1024 * 1024

export interface OrchestratorOptions {
  db: ScoreDb
  ingest: Ingest
  port: Pick<HermesPort, 'mode' | 'startRun' | 'stopRun' | 'listAgents' | 'mcpTools'>
  access: McpAccessStore
  fence: GlobalFenceStore
  clock?: () => number
  spend?: SpendReader
  quotaBytes?: number
  /** True when Score has a loopback MCP listener (remote mode); a fake adapter needs none. */
  mcpAvailable?: boolean
  onError?: (error: unknown) => void
  /** Minimum time between attempts to deliver an owed Stop, and the pause after a "nothing was sent" refusal. */
  retryMs?: number
  /** How long close() waits for Stop deliveries in flight (default 5 s). */
  stopDrainMs?: number
  /** What the coding runtime says about its agents and host (7.7b); absent where there is none (coding agents are then refused). */
  codingFacts?: CodingWorkerFacts
  /**
   * Checks the release decision consults after the common admission rules (7.7b §6). Part 2 of 7.7b fills the policy,
   * consent, limit and spend checks in here; each returns a typed cause to refuse the release, or undefined to allow it.
   * The default allows everything.
   */
  releaseChecks?: ReleaseChecks
  /** 3.13: starts the oracle's command (absent: a job with a check has every run refused). */
  checks?: CheckSpawner
}

/** What a release check is told about the launch it is judging. */
export interface ReleaseSubject {
  orchestrationId: string
  attemptId: string
  generation: number
  launchId: string
  /** The expiry this launch was prepared with (epoch ms). */
  expiry: number
  /** The id of the worker policy the launch's invocation was built from (coding workers). */
  policyId?: string | undefined
  /** Launches of this orchestration that may have executed, read from the coding journal inside the critical section. */
  executed?: number | undefined
}
export interface ReleaseChecks {
  /** The policy checks (prepared spec, bound identities, consent); runs in the release read transaction, never writes. */
  policy?(sqlite: DatabaseSync, subject: ReleaseSubject): string | undefined
  /** The coding step limit and unknown-cost acceptance. */
  limits?(sqlite: DatabaseSync, subject: ReleaseSubject): string | undefined
}

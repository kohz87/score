import {
  type AgentSummary,
  WORKFLOW_LIMITS,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_CAPACITY,
  ORCH_DEFAULTS,
  ORCH_LIMITS,
  ORC_CAPABILITY_PLACEHOLDER,
  type GateDecision,
  type InquiryAnswer,
  type LimitsDecision,
  type OrchReceipt,
  type OrchestrationCreate,
  type OrchestrationCreated,
  type OrchestrationEvents,
  type OrchestrationList,
  type OrchestrationSnapshot,
  type OrchestrationSummary,
  type Preflight,
  type PreflightCheck,
  type AbandonDecision,
  type RunControl,
  type PolicyRemapDecision,
  type QuotaDecision,
  type RemapDecision,
  type WaiverDecision,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowPreflight,
  type WorkflowPolicyRemapDecision,
  type WorkflowRemapDecision,
  type WorkflowRetryDecision,
  type WorkflowRunCreate,
  type WorkflowRunCreated,
  type WorkflowRunEvents,
  type WorkflowRunList,
  type WorkflowRunSnapshot,
  type WorkflowRunSummary,
  type WorkflowTryAgainDecision,
} from '@score/contract'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import { isNotDispatched, type HermesPort } from '../../hermes/index.ts'
import type { DomainEventDraft, Ingest } from '../../hub/ingest.ts'
import { headSeq } from '../../hub/snapshot.ts'
import type { McpAccessStore } from '../../mcp/access.ts'
import { redact, redactBounded } from '../../redact.ts'
import { agentAdmits, agentPausedAt, lifecycleOf } from '../agent-lifecycle.ts'
import { briefTitle, createBrief, emitBriefChange } from '../briefs.ts'
import { insertRoom, storeMessage } from '../rooms.ts'
import { teamPausedAt } from '../team-pause.ts'
import {
  budgetView,
  canReserve,
  makeSpendReader,
  overBudget,
  unknownCostBlocks,
  type SpendReader,
} from './budget.ts'
import {
  containsCapability,
  hashCapability,
  mintCapability,
  valueHasCapability,
  withCapability,
} from './capability.ts'
import { runCommand, type ToolName, parseToolArgs } from './commands.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  abandonAttempts,
  answerInquiry,
  decideGate,
  expectRevision,
  grantWaiver,
  remapAgent,
  pauseRun,
  answerQuota,
  policyRemapStep,
  resumeRun,
  setLimits,
  stopRun,
} from './decisions.ts'
import { applyJournalEvidence, fenceView, isFenced, type GlobalFenceStore } from './fence.ts'
import { journalDispatches } from './journal.ts'
import { readWorkerPolicy, storeWorkerPolicy } from './coding-policy.ts'
import { admissionDenial, recoveredOnly } from './admission.ts'
import { holdOf, quotaAdmits } from './quota-guard.ts'
import { getCodingAgent } from '../../runtimes/coding/store.ts'
import {
  MAX_GENERATIONS,
  applyClosure,
  dropUnlaunchedInput,
  causeClass,
  codingTurnId,
  launchFacts,
  provenNoLaunch,
  readGeneration,
  runtimeOfAgent,
} from './coding-attempts.ts'
import type { OrchestrationOwner, ReleaseDecision } from './owner.ts'
import { insertAttemptRows, type NewAttempt } from './attempt-rows.ts'
import { CODING_RESULT_BYTES } from '../../runtimes/coding/translate.ts'
import { REPLY_TOO_LARGE_PATTERN } from '../../runtimes/coding/note.ts'
import {
  activeStepCounts,
  addStored,
  bumpAdmission,
  cascadeBlocked,
  recordRefusal,
  compactControlHistory,
  refuseAttempt,
  reserveFor,
  addCodingStored,
  CODING_ITEM_EXTRA_BYTES,
  codingItemsFor,
  codingUnsentBytes,
  codingUnsentSlots,
  setStepStatus,
} from './ops.ts'
import { renderLeadInput, renderStepInput } from './render.ts'
import { finalizeGraph, planWorkflow } from '../workflows/planner.ts'
import { workflowDetailOf, workflowEventsOf, workflowSummaryOf } from '../workflows/views.ts'
import { readVersion } from '../workflows/definitions.ts'
import { validateDefinition } from '../workflows/definition.ts'
import {
  codingAgentsOf,
  codingNodeIdsOf,
  validateWorkflowAgents,
  withAgentIssues,
} from '../workflows/agents.ts'
import {
  assertOrchestrationWorkers,
  isForbiddenPermission,
  type CodingWorkerFacts,
  type WorkerReport,
} from './supported-agents.ts'
import {
  agentIdsOf,
  defaultCodingSteps,
  insertWorkflowRun,
  stepBudgetOf,
  validateInputs,
  workflowReserve,
} from '../workflows/runs.ts'
import { decideNodeGate, remapWorkflow, retryNode, tryAgain } from '../workflows/decisions.ts'
import { nodesOf, readResult, requireWfRun } from '../workflows/store.ts'
import { timelineOf } from './timeline.ts'
import { pruneOrchestrationRows } from './prune.ts'
import {
  type HelpersConfig,
  helperLines,
  helpersOf,
  settleHelpers,
  startScan,
  usesHelperSlot,
} from './helpers.ts'
import {
  ADVISOR_STEPS,
  adviceArrived,
  adviseOnRepeatCheckFailure,
  adviseOnRepeatFailure,
  isAdvisorStep,
} from './advisor.ts'
import { splitCommand } from './check-command.ts'
import {
  CHECK_LEAD_BYTES,
  CHECK_OUTPUT_BYTES,
  type CheckConfig,
  checkConfigOf,
  checkIsCurrent,
  checkPending,
  checksOf,
  personRunsCheck,
  shownCommand,
  queueCheckAfterStep,
  tailBytes,
  waiveCheck,
} from './checks.ts'
import type { CheckProcess, CheckSpawner } from '../../runtimes/check/spawn-check.ts'
import {
  AttemptRowSchema,
  addCause,
  addHistory,
  attemptsOf,
  causesAfter,
  frozenIncarnation,
  gatesOf,
  inquiriesOf,
  isTerminalStatus,
  leadOf,
  listLeadOrchs,
  listOrchs,
  listWorkflowOrchs,
  readAttempt,
  readOrch,
  readStep,
  requireOrch,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from './store.ts'
import {
  cancelFenceAttempts,
  detailOf,
  ownershipOf,
  summaryOf,
  unknownFenceAttempts,
} from './views.ts'

interface RunFacts {
  status: string
  output: string | null
  error: string | null
  ended_at: string | null
  terminal_source: string | null
}

/** Only a runtime's own, confirmed terminal word is evidence; text rebuilt from history, or a run whose process group was never proven gone, is not (fix-h item 1, fix-w). */
const isEvidence = (run: RunFacts): boolean =>
  (run.status === 'completed' || run.status === 'failed') &&
  run.terminal_source !== 'recovered' &&
  run.terminal_source !== 'unconfirmed'

export const ORCHESTRATION_QUOTA_BYTES = 200 * 1024 * 1024
const SWEEP_MS = 10_000

/** Every step a run may hold: the lead's, its helpers' and the advisor's consults (3.14–3.16). */
const effectiveSteps = (body: OrchestrationCreate): number =>
  body.maxSteps +
  (body.helpers?.maxSteps ?? 0) +
  (body.advisorAgentId !== undefined ? ADVISOR_STEPS : 0)
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

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

type ToolResult =
  { kind: 'receipt'; receipt: OrchReceipt } | { kind: 'unauthorized'; message: string }

/** A step attempt given to a coding worker (its launches are supervised units, its result is the eligible reply). */
const isCodingStep = (attempt: Pick<AttemptRow, 'kind' | 'runtime'>): boolean =>
  attempt.kind === 'step' && attempt.runtime !== 'hermes'

/** The launch of the attempt's current generation has end proof in the database projection (a cheap read). */
function codingProofIn(sqlite: DatabaseSync, attempt: AttemptRow): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM coding_launches l JOIN orc_generations g ON g.launch_id = l.launch_id
       WHERE g.attempt_id = ? AND g.generation = ? AND l.phase IN ('ended', 'settled') AND l.proof IS NOT NULL AND l.waiver = 0`,
    )
    .get(attempt.id, attempt.dispatch_generation)
  return row !== undefined
}

/** The typed cause a coding runtime attached to a refusal raised before the run was queued, if any. */
function codingFailureCause(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined
  const details = error.details as { cause?: unknown } | null | undefined
  return typeof details?.cause === 'string' ? details.cause : undefined
}

/** A lead-planned run; a workflow run id answers 404 here (its routes are /api/workflow-runs). */
function requireLeadOrch(sqlite: DatabaseSync, id: string): OrchRow {
  const o = requireOrch(sqlite, id)
  if (o.planner !== 'lead')
    throw new HttpError(404, 'not_found', 'Couldn’t find that orchestration.')
  return o
}

/**
 * The orchestration executor: the single admission authority for lead attempts and steps (design v3). All writes go
 * through `mutate`, one ingest transaction each, so events, revisions and the database stay consistent.
 */
export class Orchestrator {
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

  constructor(private readonly options: OrchestratorOptions) {
    this.db = options.db
    this.ingest = options.ingest
    this.clock = options.clock ?? Date.now
    this.spend = options.spend ?? makeSpendReader(options.port.mode !== 'fake')
    this.quotaBytes = options.quotaBytes ?? ORCHESTRATION_QUOTA_BYTES
    this.retryMs = options.retryMs ?? 5_000
    this.lineageProvable = options.port.mode === 'fake'
    options.fence.onChange = () => this.announceFence()
  }

  // ---------------------------------------------------------------------------------------------------- lifecycle

  /** Crash recovery, then event-driven operation plus a periodic sweep. */
  async start(): Promise<void> {
    await this.recover()
    if (this.options.fence.view().fenced) this.announceFence()
    const maintain = () => {
      try {
        this.maintenance()
      } catch (error) {
        this.err(error)
      }
    }
    maintain()
    this.maintenanceTimer = setInterval(maintain, 24 * 60 * 60 * 1000)
    this.maintenanceTimer.unref()
    this.unsubscribe = this.ingest.onCommitted((events) => {
      if (events.some((event) => event.type === 'run.updated')) this.kick()
    })
    this.timer = setInterval(() => this.kick(), SWEEP_MS)
    this.timer.unref()
    this.kick()
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    clearInterval(this.timer)
    clearInterval(this.maintenanceTimer)
    await this.pumping?.catch(() => undefined)
    // A check still running is stopped with its process group; the next start records it as interrupted.
    // Killed outright: the process is about to exit, so a grace timer would never fire.
    for (const job of this.checkJobs.values()) job.proc.stop(true)
    // Stops in flight get up to 5 s to answer; the rest stay durably owed and are asked again after the next start.
    if (this.stopJobs.size > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...this.stopJobs.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.stopDrainMs ?? 5_000)
        }),
      ])
      clearTimeout(timer)
      this.abandonStops = true
    }
  }

  private err(error: unknown): void {
    this.options.onError?.(error)
  }

  kick(): void {
    if (this.closed) return
    void this.pump().catch((error: unknown) => this.err(error))
  }

  /** Runs the executor until it has nothing left to do right now. Concurrent calls share one run. */
  pump(): Promise<void> {
    if (this.pumping) {
      this.again = true
      return this.pumping
    }
    this.pumping = (async () => {
      do {
        this.again = false
        await this.cycle()
      } while (this.again && !this.closed)
    })().finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  }

  /**
   * v8.2 item 1: an agent that becomes served again (a version check or gateway reachability recovering) wakes the
   * attempts that waited out refusals. Only asked while some attempt is in that wait.
   */
  private readinessWaiting(): boolean {
    return this.db.read(
      (sqlite) =>
        sqlite
          .prepare(
            "SELECT 1 FROM orc_attempts WHERE state = 'created' AND refused_streak > 0 AND needs_person = 0 LIMIT 1",
          )
          .get() !== undefined,
    )
  }

  private async observeReadiness(): Promise<void> {
    try {
      for (const agent of await this.options.port.listAgents()) {
        const before = this.served.get(agent.id)
        this.served.set(agent.id, agent.served)
        if (before === false && agent.served) await this.agentReady(agent.id)
      }
    } catch (error) {
      this.err(error)
    }
  }

  private async cycle(): Promise<void> {
    // Not awaited when nothing waits, so the cycle starts in the same tick as before.
    if (this.readinessWaiting()) await this.observeReadiness()
    for (let round = 0; round < 100 && !this.closed; round++) {
      let progressed = await this.reconcile()
      const live = this.db.read((sqlite) =>
        listOrchs(sqlite).some((o) => !isTerminalStatus(o.status)),
      )
      if (live) await this.mutate((ctx) => this.sweep(ctx))
      // Not awaited unless a queued Antigravity step needs a fresh reading (tests rely on the cycle's tick order).
      const refreshing = this.refreshQuota()
      if (refreshing) await refreshing
      const jobs = await this.mutate((ctx) => this.admit(ctx))
      for (const id of jobs) progressed = (await this.dispatch(id)) || progressed
      progressed = (await this.serviceStops()) || progressed
      progressed = (await this.serviceChecks()) || progressed
      if (!progressed) return
    }
  }

  /** Test aid: resolves once the executor is idle. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping
  }

  private nowMs(): number {
    return this.clock()
  }

  // -------------------------------------------------------------------------------------------------- transactions

  private async mutate<T>(fn: (ctx: Ctx) => T): Promise<T> {
    let result!: T
    let failure: string | undefined
    // Cache updates are staged and published only once the transaction has committed; a rollback must not leave
    // "already seen" marks behind for projections that were never stored.
    const staged = { fingerprints: new Map<string, string>(), ownership: new Map<string, string>() }
    await this.ingest.submit({
      source: 'orchestration',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const ctx: Ctx = {
          sqlite,
          now,
          journal: this.options.fence.journal,
          touched: new Set(),
          events: [],
          ...(this.options.codingFacts?.quota ? { quota: this.options.codingFacts.quota } : {}),
        }
        result = fn(ctx)
        const events = [...ctx.events, ...this.finalize(ctx, staged)]
        failure = ctx.journalFailure
        return events
      },
    })
    for (const [id, value] of staged.fingerprints) this.fingerprints.set(id, value)
    for (const [id, value] of staged.ownership) this.ownershipSeen.set(id, value)
    if (failure !== undefined) this.fenceNow('journal_unwritable', failure)
    return result
  }

  private fenceNow(reason: string, detail: string): void {
    try {
      this.options.fence.set(reason, [{ kind: 'journal', ref: 'journal', journalN: null, detail }])
    } catch (error) {
      this.err(error)
    }
  }

  /** Settles each touched run, bumps its revision when anything changed and emits its summary. */
  private finalize(
    ctx: Ctx,
    staged: { fingerprints: Map<string, string>; ownership: Map<string, string> },
  ): DomainEventDraft[] {
    const { sqlite, now } = ctx
    const events: DomainEventDraft[] = []
    for (let pass = 0; pass < 4; pass++) {
      let changed = false
      for (const id of [...ctx.touched]) changed = this.settle(ctx, id) || changed
      if (!changed) break
    }
    for (const id of ctx.touched) {
      const o = readOrch(sqlite, id)
      if (!o) continue
      const workflow = o.planner === 'workflow'
      const fingerprint = createHash('sha1')
        .update(
          JSON.stringify({
            ...(workflow
              ? workflowDetailOf(sqlite, o, now, {
                  lineageProvable: this.lineageProvable,
                  skipStorage: true,
                  ...(this.options.codingFacts ? { facts: this.options.codingFacts } : {}),
                })
              : detailOf(sqlite, o)),
            revision: 0,
            updatedAt: '',
          }),
        )
        .digest('hex')
      if ((staged.fingerprints.get(id) ?? this.fingerprints.get(id)) === fingerprint) continue
      staged.fingerprints.set(id, fingerprint)
      // Ownership transitions (owned, draining, released) are part of the recorded history.
      const ownership = ownershipOf(o, attemptsOf(sqlite, o.id))
      if ((staged.ownership.get(id) ?? this.ownershipSeen.get(id)) !== ownership) {
        staged.ownership.set(id, ownership)
        addHistory(sqlite, id, 'ownership', { state: ownership }, now)
      }
      compactControlHistory(sqlite, id)
      sqlite
        .prepare('UPDATE orchestrations SET revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(now, id)
      const fresh = readOrch(sqlite, id)!
      events.push(
        workflow
          ? {
              type: 'workflow.run.upserted',
              data: workflowSummaryOf(
                sqlite,
                fresh,
                this.options.fence.journal,
                this.options.codingFacts,
              ),
            }
          : { type: 'orchestration.upserted', data: summaryOf(sqlite, fresh) },
      )
      events.push(...emitBriefChange(sqlite, o.brief_id))
    }
    return events
  }

  /** Emits the global fence to the stream (set at start, by a journal failure, or lifted by the person). */
  announceFence(): void {
    void this.ingest
      .submit({
        source: 'orchestration',
        identity: randomUUID(),
        apply: ({ sqlite }) => [
          {
            type: 'orchestration.fence.updated',
            data: fenceView(sqlite, this.options.fence.journal),
          },
        ],
      })
      .catch((error: unknown) => this.err(error))
  }

  // ------------------------------------------------------------------------------------------------------- reads

  list(): OrchestrationList {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      items: listLeadOrchs(sqlite).map((o) => summaryOf(sqlite, o)),
    }))
  }

  snapshot(id: string): OrchestrationSnapshot {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      orchestration: detailOf(sqlite, requireLeadOrch(sqlite, id)),
    }))
  }

  /** Event history for the live diagram, log and replay (contract §14 "Events"). */
  events(id: string): OrchestrationEvents {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      events: timelineOf(sqlite, requireLeadOrch(sqlite, id)),
    }))
  }

  summary(id: string): OrchestrationSummary {
    return this.db.read((sqlite) => summaryOf(sqlite, requireLeadOrch(sqlite, id)))
  }

  /**
   * Journals a team or agent pause hold (or its lift) before the route changes the database, so a database that later
   * loses the hold is fenced. A journal that cannot be written fences admission at once (fail closed).
   */
  recordHold(
    target: { kind: 'team' } | { kind: 'agent'; agentId: string },
    action: 'set' | 'lift',
  ): void {
    try {
      this.options.fence.journal.append({
        kind: 'hold',
        target: target.kind,
        ...(target.kind === 'agent' ? { agentId: target.agentId } : {}),
        action,
      })
    } catch (error) {
      this.fenceNow('journal_unwritable', error instanceof Error ? error.message : String(error))
    }
  }

  fenceStore(): GlobalFenceStore {
    return this.options.fence
  }

  // ----------------------------------------------------------------------------------------------- preflight, create

  /**
   * `agents` is the team as the caller sees it (the HTTP routes pass the cached agent directory, which is fast against a
   * live Hermes); without it the adapter is asked.
   */
  async preflight(
    leadAgentId: string,
    allowedAgents: string[],
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps?: number,
  ): Promise<Preflight> {
    return (await this.preflightWith(leadAgentId, allowedAgents, agents, maxConcurrentSteps))
      .preflight
  }

  /** The preflight and, for each coding worker, the full report its policy came from (create stores the policy). */
  private async preflightWith(
    leadAgentId: string,
    allowedAgents: string[],
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    // F2 #2: the quota check reserves unsent coding inventory for the concurrency the request asks for.
    maxConcurrentSteps: number = ORCH_DEFAULTS.maxConcurrentSteps,
  ): Promise<{ preflight: Preflight; reports: Map<string, WorkerReport> }> {
    const { port, access } = this.options
    const fake = port.mode === 'fake'
    const checks: PreflightCheck[] = []
    const add = (id: PreflightCheck['id'], status: PreflightCheck['status'], message: string) =>
      checks.push({ id, status, message })
    const team = agents ?? (await port.listAgents())
    assertOrchestrationWorkers(leadAgentId, allowedAgents, team, this.options.codingFacts)
    const known = new Map(team.map((agent) => [agent.id, agent]))
    // Each coding worker: can it take a step now, and what policy would the person approve (7.7b §3).
    const reports = new Map<string, WorkerReport>()
    for (const id of new Set(allowedAgents)) {
      const runtime = known.get(id)?.runtime
      if (runtime && runtime !== 'hermes' && this.options.codingFacts)
        reports.set(id, await this.options.codingFacts.report(id))
    }
    const ready = (id: string): string | undefined => {
      const agent = known.get(id)
      if (!agent) return `${id} is not a team member`
      if (!this.db.read((sqlite) => agentAdmits(sqlite, id)))
        return `${id} is not ready for new work`
      if (!fake && !agent.served) return `${id} is not served by Hermes right now`
      return undefined
    }
    add(
      'listener',
      fake || this.options.mcpAvailable ? 'ok' : 'fail',
      fake
        ? 'The fake adapter runs a scripted lead; no MCP listener is needed'
        : this.options.mcpAvailable
          ? 'The loopback MCP listener is up'
          : 'Orchestrations need remote mode: the lead reaches its tools through the loopback MCP listener',
    )
    const leadProblem = ready(leadAgentId)
    add('lead_ready', leadProblem ? 'fail' : 'ok', leadProblem ?? `${leadAgentId} is ready`)
    const state = access.get(leadAgentId)
    add(
      'lead_mcp_access',
      fake || state.enabled ? 'ok' : 'fail',
      fake || state.enabled
        ? 'MCP access is on for the lead (the writes switch is not needed)'
        : `Turn on MCP access for ${leadAgentId} in Team › Tools`,
    )
    add(
      'lead_mcp_token',
      fake || state.hasToken ? 'ok' : 'fail',
      fake || state.hasToken
        ? 'The lead has an MCP token'
        : `Create an MCP token for ${leadAgentId} and add it to the profile`,
    )
    const problems = [
      ...(allowedAgents.length === 0 ? ['choose at least one agent for the steps'] : []),
      ...(allowedAgents.includes(leadAgentId)
        ? [`${leadAgentId} leads this run and cannot also do steps`]
        : []),
      ...allowedAgents.flatMap((id) => {
        const problem = ready(id)
        return problem ? [problem] : []
      }),
      ...[...reports].flatMap(([id, report]) =>
        report.readiness === 'ready' ? [] : [`${id}: ${report.detail ?? report.readiness}`],
      ),
    ]
    add(
      'allowed_agents',
      problems.length ? 'fail' : 'ok',
      problems.join('; ') || 'All step agents are ready',
    )
    const fence = this.options.fence.view()
    add(
      'global_fence',
      fence.fenced ? 'fail' : 'ok',
      fence.fenced
        ? `Admission is fenced (${fence.reason}); review the list in Settings`
        : 'No fence',
    )
    add(
      'journal',
      fence.journal.ok && !fence.journal.sizeAlarm ? 'ok' : 'fail',
      fence.journal.ok
        ? fence.journal.sizeAlarm
          ? 'The execution journal is over its size alarm'
          : 'The execution journal is healthy'
        : 'The execution journal cannot be read',
    )
    const running = this.db.read((sqlite) => this.capacityUsed(sqlite))
    add(
      'capacity',
      running < ORCH_CAPACITY.runningOrchestrations ? 'ok' : 'fail',
      running < ORCH_CAPACITY.runningOrchestrations
        ? `${running} of ${ORCH_CAPACITY.runningOrchestrations} orchestrations are running`
        : `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running.`,
    )
    const reserve = reserveFor(
      12,
      20,
      reports.size > 0 ? codingItemsFor(12, ORCH_DEFAULTS.codingSteps) : 0,
      reports.size > 0 ? codingUnsentBytes(12, maxConcurrentSteps) : 0,
    )
    const fits = this.db.read((sqlite) => this.quotaUsed(sqlite) + reserve <= this.quotaBytes)
    add(
      'quota',
      fits ? 'ok' : 'fail',
      fits
        ? 'There is room for another run'
        : 'Orchestration storage is full; remove old runs first',
    )
    // Hermes caches the MCP tool list per connection: the lead's serving process must list every orch.* tool.
    const required = [
      'orch.plan',
      'orch.assign',
      'orch.cancel',
      'orch.ask',
      'orch.requestApproval',
      'orch.note',
      'orch.finish',
      'orch.receipt',
    ]
    // The adapter's answer where it can ask (fake); otherwise what Score's own MCP server last handed the lead (3.7.8).
    const ownList = !leadProblem && !port.mcpTools
    const handed = ownList ? access.listed(leadAgentId) : null
    const listed = leadProblem
      ? null
      : port.mcpTools
        ? await port.mcpTools(leadAgentId).catch(() => null)
        : (handed?.names ?? null)
    if (listed) {
      const missing = required.filter((name) => !listed.includes(name))
      add(
        'tool_readiness',
        missing.length ? 'fail' : 'ok',
        missing.length
          ? `The lead's Hermes ${handed ? 'was last handed a tool list without' : 'does not list'} ${missing.join(', ')}. Reload MCP (/reload-mcp in that profile, or restart its gateway), then try again.`
          : 'The lead sees every orch.* tool',
      )
    } else if (ownList)
      add(
        'tool_readiness',
        'unknown',
        "The lead's Hermes hasn't asked Score for its tools since its MCP key was set up. Reload MCP in that profile (/reload-mcp, or restart its gateway) so Score can check them.",
      )
    else
      add(
        'tool_readiness',
        fake ? 'ok' : 'unknown',
        fake
          ? 'Scripted lead'
          : 'Score cannot see which MCP tools the lead has. Hermes caches the tool list per connection, so after Score is upgraded reload MCP (/reload-mcp, or restart the gateway) before starting.',
      )
    const preflight: Preflight = {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
      workers: [...reports].map(([agentId, report]) => ({
        agentId,
        runtime: known.get(agentId)!.runtime as 'claude-code' | 'codex',
        readiness: report.readiness,
        detail: report.detail,
        policyId: report.policyId,
        reach: report.reach,
        reachBeyondWorkspace: report.reachBeyondWorkspace,
      })),
      gatePolicyNotes: {
        'every-step': 'You approve every assignment before it starts.',
        'lead-asks':
          'A step starts without approval unless the lead asks you. Steps wait until the lead has finished its turn so it can ask first.',
        none: 'Assignments start without approval. Budget uncertainty and agent tool approvals still reach you.',
      },
      acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
      defaults: {
        maxSteps: 12,
        maxLeadTurns: 20,
        maxConcurrentSteps: 2,
        leadTurnEstimateUsd: 0.25,
        stepEstimateUsd: 0.5,
        codingSteps: ORCH_DEFAULTS.codingSteps,
      },
      reserveBytes: reserve,
    }
    return { preflight, reports }
  }

  /** Orchestrations that hold capacity: running ones, and finished ones whose attempts are still not confirmed ended. */
  private capacityUsed(sqlite: DatabaseSync): number {
    return listOrchs(sqlite).filter(
      (o) =>
        !isTerminalStatus(o.status) ||
        attemptsOf(sqlite, o.id).some((a) => a.state === 'unknown' && a.abandoned_at === null),
    ).length
  }

  /** Whether the whole database still has storage for `extra` more reserved bytes (a coding limit that grows a reserve). */
  private readonly storageFits = (sqlite: DatabaseSync, extra: number): boolean =>
    this.quotaUsed(sqlite) + extra <= this.quotaBytes

  private quotaUsed(sqlite: DatabaseSync): number {
    return listOrchs(sqlite).reduce(
      (sum, o) =>
        sum +
        (isTerminalStatus(o.status) ? o.stored_bytes : Math.max(o.reserve_bytes, o.stored_bytes)),
      0,
    )
  }

  async create(
    body: OrchestrationCreate,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
  ): Promise<OrchestrationCreated> {
    // 3.14–3.15: the advisor and helpers are checked (served, coding consent) like the agents the lead may assign to.
    const advisor = body.advisorAgentId
    if (advisor !== undefined && advisor === body.leadAgentId)
      throw new HttpError(400, 'bad_request', 'The advisor has to be another agent than the lead.')
    const helpers = body.helpers
    if (helpers) {
      if (helpers.agentIds.includes(body.leadAgentId))
        throw new HttpError(400, 'bad_request', 'The lead can’t be one of its own helpers.')
      if (new Set(helpers.agentIds).size !== helpers.agentIds.length)
        throw new HttpError(400, 'bad_request', 'A helper is listed twice.')
      if (helpers.scan && !helpers.scanFolder && !body.check)
        throw new HttpError(400, 'bad_request', 'Say which folder the helpers should scan.')
    }
    const extra = [
      ...new Set([...(advisor !== undefined ? [advisor] : []), ...(helpers?.agentIds ?? [])]),
    ].filter((agent) => !body.allowedAgents.includes(agent))
    const { preflight, reports } = await this.preflightWith(
      body.leadAgentId,
      [...body.allowedAgents, ...extra],
      agents,
      body.maxConcurrentSteps,
    )
    if (new Set(body.allowedAgents).size !== body.allowedAgents.length)
      throw new HttpError(400, 'bad_request', 'An agent is listed twice in the allowed agents.')
    if (!preflight.ok) {
      const failed = (id: string) =>
        preflight.checks.some((check) => check.id === id && check.status === 'fail')
      const details = { checks: preflight.checks }
      if (failed('global_fence'))
        throw new HttpError(
          409,
          'fenced',
          'New runs can’t start until you review the runs that need checking on Now.',
          details,
        )
      if (failed('capacity'))
        throw new HttpError(429, 'capacity', 'Too many orchestrations are running.', details)
      if (failed('quota'))
        throw new HttpError(
          409,
          'quota_exhausted',
          'Score has no storage left for orchestrations.',
          details,
        )
      throw new HttpError(409, 'preflight_failed', 'The check before the run failed.', details)
    }
    // Consent is by policy id (7.7b §4): the id the person saw must still be the agent's, and a reach beyond the workspace
    // needs the acknowledgement of exactly that id.
    for (const [agentId, report] of reports) {
      const seen = body.codingPolicies?.[agentId]
      if (seen === undefined)
        throw new HttpError(
          400,
          'bad_request',
          `The request has to name the settings it was approved with for ${agentId}.`,
        )
      if (seen !== report.policyId)
        throw new HttpError(
          409,
          'policy_changed',
          `${agentId} changed since you looked. Check what it can reach and start again.`,
          { agentId, currentPolicyId: report.policyId },
        )
      if (
        report.reachBeyondWorkspace &&
        !body.acknowledgeCodingReach?.policyIds.includes(report.policyId!)
      )
        throw new HttpError(
          409,
          'reach_not_acknowledged',
          `${agentId} can read beyond its workspace. Accept that before the run starts.`,
          { agentId, policyId: report.policyId },
        )
    }
    let check: CheckConfig | null = null
    if (body.check) {
      const split = splitCommand(body.check.command)
      if (!split.ok) throw new HttpError(400, 'invalid_check', split.reason)
      check = {
        argv: split.argv,
        workspace: body.check.workspace,
        timeoutSec: body.check.timeoutSec,
        when: body.check.when,
      }
    }
    const id = `orc-${randomUUID().slice(0, 8)}`
    await this.mutate((ctx) => {
      this.insert(ctx, id, body, preflight, reports)
      if (helpers) {
        const config: HelpersConfig = {
          agentIds: helpers.agentIds,
          maxConcurrent: helpers.maxConcurrent,
          maxSteps: helpers.maxSteps,
          scan: helpers.scan,
          scanFolder: helpers.scanFolder ?? (helpers.scan ? (body.check?.workspace ?? null) : null),
          splitTo: helpers.splitTo,
        }
        ctx.sqlite
          .prepare('UPDATE orchestrations SET helpers_json = ? WHERE id = ?')
          .run(JSON.stringify(config), id)
        const freeze = ctx.sqlite.prepare(
          `INSERT OR IGNORE INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, 'agent', ?, ?)`,
        )
        for (const agent of helpers.agentIds)
          freeze.run(
            id,
            agent,
            lifecycleOf(ctx.sqlite, agent)?.incarnation_id ?? 'untracked',
            ctx.now,
          )
        addHistory(ctx.sqlite, id, 'helpers_set', { ...config }, ctx.now)
        if (config.scan && config.scanFolder)
          startScan(ctx, readOrch(ctx.sqlite, id)!, config.scanFolder)
      }
      if (advisor !== undefined) {
        ctx.sqlite
          .prepare('UPDATE orchestrations SET advisor_agent_id = ? WHERE id = ?')
          .run(advisor, id)
        // Frozen like every agent the run was started with, so a replaced advisor waits for the person's remap.
        ctx.sqlite
          .prepare(
            `INSERT OR IGNORE INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, 'agent', ?, ?)`,
          )
          .run(
            id,
            advisor,
            lifecycleOf(ctx.sqlite, advisor)?.incarnation_id ?? 'untracked',
            ctx.now,
          )
        addHistory(ctx.sqlite, id, 'advisor_set', { agentId: advisor }, ctx.now)
      }
      if (check) {
        ctx.sqlite
          .prepare('UPDATE orchestrations SET check_json = ? WHERE id = ?')
          .run(JSON.stringify(check), id)
        addHistory(
          ctx.sqlite,
          id,
          'check_set',
          { command: shownCommand(check.argv), workspace: check.workspace },
          ctx.now,
        )
      }
    })
    this.kick()
    return { orchestration: this.summary(id), preflight }
  }

  private insert(
    ctx: Ctx,
    id: string,
    body: OrchestrationCreate,
    preflight: Preflight,
    reports: Map<string, WorkerReport>,
  ): void {
    const { sqlite, now } = ctx
    if (isFenced(sqlite))
      throw new HttpError(
        409,
        'fenced',
        'New runs can’t start until you review the runs that need checking on Now.',
      )
    const live = this.capacityUsed(sqlite)
    if (live >= ORCH_CAPACITY.runningOrchestrations)
      throw new HttpError(
        429,
        'capacity',
        `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running.`,
      )
    // 3.14–3.16 (review): helper work and consults are steps too; the storage and coding reserves are sized for them.
    const steps = effectiveSteps(body)
    const concurrent = body.maxConcurrentSteps + (body.helpers?.maxConcurrent ?? 0)
    const reserve = reserveFor(
      steps,
      body.maxLeadTurns,
      reports.size > 0 ? codingItemsFor(steps, body.codingSteps ?? ORCH_DEFAULTS.codingSteps) : 0,
      reports.size > 0 ? codingUnsentBytes(steps, concurrent) : 0,
    )
    if (this.quotaUsed(sqlite) + reserve > this.quotaBytes)
      throw new HttpError(
        409,
        'quota_exhausted',
        'Score has no storage left for this orchestration.',
      )
    if (body.deadlineAt !== undefined && body.deadlineAt <= now)
      throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
    const title = body.title ?? briefTitle(body.goal)
    const roomId = `room-${id}`
    const messageId = `orc-goal:${id}`
    const lifecycle = lifecycleOf(sqlite, body.leadAgentId)
    insertRoom(
      sqlite,
      {
        id: roomId,
        name: `Orchestration: ${title.slice(0, 80)} (${id.slice(4)})`,
        kind: 'room',
        leadAgentId: body.leadAgentId,
        members: [body.leadAgentId, ...body.allowedAgents],
        // The executor routes this room itself (PLAN 11.11 moves only the rooms people talk in).
        routing: 'mentions',
      },
      now,
    )
    ctx.events.push(
      ...storeMessage(
        sqlite,
        {
          id: messageId,
          roomId,
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: body.goal }],
          createdAt: now,
          streaming: false,
          refs: [],
        },
        now,
      ),
    )
    // The brief's event is dropped: its first status is the run's, emitted when the run is touched below.
    createBrief(sqlite, { id: messageId, roomId, text: body.goal }, now)
    sqlite
      .prepare(
        `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy,
           budget_usd, deadline_at, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd,
           status, acknowledgement, preflight, reserve_bytes, stored_bytes, created_at, updated_at, coding_steps, accepted_unknown_cost,
           coding_reserve_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        body.goal,
        body.leadAgentId,
        lifecycle?.incarnation_id ?? 'untracked',
        JSON.stringify(body.allowedAgents),
        roomId,
        messageId,
        body.gatePolicy,
        body.budgetUsd ?? null,
        body.deadlineAt ?? null,
        body.maxSteps,
        body.maxLeadTurns,
        body.maxConcurrentSteps,
        body.leadTurnEstimateUsd,
        body.stepEstimateUsd,
        JSON.stringify({ text: ORCH_ACKNOWLEDGEMENT_TEXT, at: now }),
        JSON.stringify(preflight),
        reserve,
        Buffer.byteLength(body.goal) + 1024,
        now,
        now,
        body.codingSteps ?? ORCH_DEFAULTS.codingSteps,
        JSON.stringify([...new Set(body.acceptUnknownCost ?? [])].sort()),
        reports.size > 0
          ? codingItemsFor(effectiveSteps(body), body.codingSteps ?? ORCH_DEFAULTS.codingSteps) *
              CODING_ITEM_EXTRA_BYTES +
              codingUnsentBytes(
                effectiveSteps(body),
                body.maxConcurrentSteps + (body.helpers?.maxConcurrent ?? 0),
              )
          : 0,
      )
    if (body.quotaFloorPercent !== undefined)
      sqlite
        .prepare('UPDATE orchestrations SET quota_floor_percent = ? WHERE id = ?')
        .run(body.quotaFloorPercent, id)
    // The policy each coding worker is approved with, and the acknowledgement that covered it (stored in the history).
    for (const [agentId, report] of reports) {
      storeWorkerPolicy(
        sqlite,
        id,
        agentId,
        {
          policyId: report.policyId!,
          policy: report.policy!,
          reach: report.reach!,
          reachBeyondWorkspace: report.reachBeyondWorkspace,
          acknowledged: body.acknowledgeCodingReach?.policyIds.includes(report.policyId!) ?? false,
        },
        now,
      )
    }
    if (reports.size > 0) {
      addHistory(
        sqlite,
        id,
        'coding_reach_acknowledged',
        {
          policyIds: [...reports.values()]
            .filter((report) => body.acknowledgeCodingReach?.policyIds.includes(report.policyId!))
            .map((report) => report.policyId),
        },
        now,
      )
      // The limits the person started with are journaled like any later change (verified after a restore).
      journalSoft(ctx, () =>
        ctx.journal.append({
          kind: 'authorization',
          orchestrationId: id,
          budgetUsd: body.budgetUsd ?? null,
          deadlineAt: body.deadlineAt ?? null,
          acceptUnknownSpend: false,
          codingSteps: body.codingSteps ?? ORCH_DEFAULTS.codingSteps,
          acceptUnknownCost: [...new Set(body.acceptUnknownCost ?? [])].sort(),
        }),
      )
    }
    // Freeze who this run was started with: the lead and every allowed agent (fix-h item 3).
    const freeze = sqlite.prepare(
      'INSERT INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    freeze.run(id, body.leadAgentId, 'lead', lifecycle?.incarnation_id ?? 'untracked', now)
    for (const agentId of body.allowedAgents)
      freeze.run(
        id,
        agentId,
        'agent',
        lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked',
        now,
      )
    // 3.15: with a scan, the lead's first turn waits for it (settleHelpers adds 'started' when it is done).
    if (!body.helpers?.scan) addCause(sqlite, id, 'started', null, now)
    addHistory(
      sqlite,
      id,
      'created',
      { leadAgentId: body.leadAgentId, gatePolicy: body.gatePolicy },
      now,
    )
    touch(ctx, id)
    ctx.events.push(...emitBriefChange(sqlite, messageId, true))
  }

  // ---------------------------------------------------------------------------------------------- human decisions

  private async decide(id: string, fn: (ctx: Ctx) => void): Promise<OrchestrationSummary> {
    // A workflow run answers 404 before anything changes: its controls are /api/workflow-runs/:id/….
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    await this.mutate((ctx) => {
      fn(ctx)
    })
    this.kick()
    return this.summary(id)
  }

  gateDecision(id: string, gateId: string, body: GateDecision) {
    return this.decide(id, (ctx) => decideGate(ctx, id, gateId, body))
  }
  inquiryAnswer(id: string, inquiryId: string, body: InquiryAnswer) {
    return this.decide(id, (ctx) => answerInquiry(ctx, id, inquiryId, body))
  }
  limits(id: string, body: LimitsDecision) {
    return this.decide(id, (ctx) => setLimits(ctx, id, body, this.storageFits))
  }
  pause(id: string, body: RunControl) {
    return this.decide(id, (ctx) => pauseRun(ctx, id, body))
  }
  resume(id: string, body: RunControl) {
    return this.decide(id, (ctx) => resumeRun(ctx, id, body))
  }
  /** 3.13: the person runs the job's check now. */
  runCheck(id: string, body: RunControl) {
    return this.decide(id, (ctx) => {
      const o = requireLeadOrch(ctx.sqlite, id)
      expectRevision(o, body.orchestrationRevision)
      personRunsCheck(ctx, o)
    })
  }
  /** 3.13: the person lets the job finish successfully without a passing check. */
  waiveCheck(id: string, body: RunControl) {
    return this.decide(id, (ctx) => {
      const o = requireLeadOrch(ctx.sqlite, id)
      expectRevision(o, body.orchestrationRevision)
      waiveCheck(ctx, o)
    })
  }
  /** Stop ignores a stale page: it can only reduce risk. */
  stop(id: string) {
    return this.decide(id, (ctx) => stopRun(ctx, id))
  }
  async remap(id: string, body: RemapDecision) {
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    // A coding worker's replacement is judged on its policy as it is now (the report is asked before the transaction).
    const isCoding = this.db.read(
      (sqlite) => readWorkerPolicy(sqlite, id, body.agentId) !== undefined,
    )
    const report = isCoding ? await this.options.codingFacts?.report(body.agentId) : undefined
    return this.decide(id, (ctx) => remapAgent(ctx, id, body, report))
  }

  /** "Use the new settings" for a step blocked `agent_changed` (7.7b §12a). */
  async policyRemap(id: string, stepId: string, body: PolicyRemapDecision) {
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    const report = await this.options.codingFacts?.report(body.agentId)
    return this.decide(id, (ctx) => policyRemapStep(ctx, id, stepId, body, report))
  }

  /** The answer to a step held because its coding agent is below its quota floor (8.6). */
  quotaDecision(id: string, stepId: string, body: QuotaDecision) {
    return this.decide(id, (ctx) => answerQuota(ctx, id, stepId, body))
  }

  waiver(id: string, body: WaiverDecision) {
    return this.decide(id, (ctx) => grantWaiver(ctx, id, body))
  }
  abandon(id: string, body: AbandonDecision) {
    return this.decide(id, (ctx) => abandonAttempts(ctx, id, body))
  }

  fence(): ReturnType<GlobalFenceStore['view']> {
    return this.options.fence.view()
  }
  liftFence(
    expectedRevision: number,
    note: string | undefined,
  ): ReturnType<GlobalFenceStore['view']> {
    this.options.fence.lift(expectedRevision, note)
    this.kick()
    return this.options.fence.view()
  }

  // ------------------------------------------------------------------------------------------------------ workflows

  private requireWorkflowOrch(sqlite: DatabaseSync, id: string): OrchRow {
    const o = requireOrch(sqlite, id)
    if (o.planner !== 'workflow') throw new HttpError(404, 'not_found', 'Couldn’t find that run.')
    return o
  }

  workflowRuns(): WorkflowRunList {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      items: listWorkflowOrchs(sqlite).map((o) =>
        workflowSummaryOf(sqlite, o, this.options.fence.journal, this.options.codingFacts),
      ),
    }))
  }

  workflowSnapshot(id: string): WorkflowRunSnapshot {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      run: workflowDetailOf(
        sqlite,
        this.requireWorkflowOrch(sqlite, id),
        new Date(this.nowMs()).toISOString(),
        {
          lineageProvable: this.lineageProvable,
          journal: this.options.fence.journal,
          ...(this.options.codingFacts ? { facts: this.options.codingFacts } : {}),
        },
      ),
    }))
  }

  workflowEvents(id: string): WorkflowRunEvents {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      events: workflowEventsOf(sqlite, this.requireWorkflowOrch(sqlite, id)),
    }))
  }

  workflowSummary(id: string): WorkflowRunSummary {
    return this.db.read((sqlite) =>
      workflowSummaryOf(
        sqlite,
        this.requireWorkflowOrch(sqlite, id),
        this.options.fence.journal,
        this.options.codingFacts,
      ),
    )
  }

  /**
   * The one runtime validation of a workflow (7.7c §1): the graph rules plus the team and host rules for coding agents.
   * Validate, save, new versions, preflight and start all call this, so none of them can disagree.
   */
  async validateWorkflow(
    definition: WorkflowDefinition,
    agents?: Pick<AgentSummary, 'id' | 'runtime'>[],
  ): Promise<ValidationResult> {
    const team = agents ?? (await this.options.port.listAgents())
    return withAgentIssues(
      validateDefinition(definition),
      validateWorkflowAgents(definition, team, this.options.codingFacts),
    )
  }

  async workflowPreflight(
    workflowId: string,
    version: number,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps?: number,
  ): Promise<WorkflowPreflight> {
    return (await this.workflowPreflightWith(workflowId, version, agents, maxConcurrentSteps))
      .preflight
  }

  /** The preflight and, for each coding agent of the workflow, the full report its policy came from (start stores it). */
  private async workflowPreflightWith(
    workflowId: string,
    version: number,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps: number = ORCH_DEFAULTS.maxConcurrentSteps,
  ): Promise<{ preflight: WorkflowPreflight; reports: Map<string, WorkerReport> }> {
    const { port } = this.options
    const fake = port.mode === 'fake'
    const checks: WorkflowPreflight['checks'] = []
    const add = (
      id: WorkflowPreflight['checks'][number]['id'],
      status: 'ok' | 'fail' | 'unknown',
      message: string,
    ) => checks.push({ id, status, message })
    const found = this.db.read((sqlite) => readVersion(sqlite, workflowId, version))
    const team = agents ?? (await port.listAgents())
    const validation = await this.validateWorkflow(found.definition, team)
    add(
      'definition',
      validation.ok ? 'ok' : 'fail',
      validation.ok
        ? 'The workflow is valid'
        : `${validation.issues.length} problems in the workflow`,
    )
    const ids = agentIdsOf(found)
    const known = new Map(team.map((agent) => [agent.id, agent]))
    // Each coding agent of the workflow: can it take a step now, and what would the person approve (7.7c §2). Only asked
    // for a definition the team and host can run at all.
    const reports = new Map<string, WorkerReport>()
    if (validation.ok && this.options.codingFacts)
      for (const id of codingAgentsOf(found.definition, team))
        reports.set(id, await this.options.codingFacts.report(id))
    const problems = [
      ...ids.flatMap((id) => {
        const agent = known.get(id)
        if (!agent) return [`${id} is not a team member`]
        if (!this.db.read((sqlite) => agentAdmits(sqlite, id)))
          return [`${id} is not ready for new work`]
        if (!fake && !agent.served) return [`${id} is not served by Hermes right now`]
        return []
      }),
      ...[...reports].flatMap(([id, report]) =>
        report.readiness === 'ready' ? [] : [`${id}: ${report.detail ?? report.readiness}`],
      ),
    ]
    add('agents', problems.length ? 'fail' : 'ok', problems.join('; ') || 'All agents are ready')
    const mapping = this.db.read((sqlite) =>
      ids.map((agentId) => ({
        agentId,
        name: agentId,
        incarnation: lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked',
      })),
    )
    add(
      'mapping',
      'ok',
      `${mapping.length} agent${mapping.length === 1 ? '' : 's'} will be bound to this run`,
    )
    const fence = this.options.fence.view()
    add(
      'global_fence',
      fence.fenced ? 'fail' : 'ok',
      fence.fenced
        ? `Admission is fenced (${fence.reason}); review the list in Settings`
        : 'No fence',
    )
    add(
      'journal',
      fence.journal.ok && !fence.journal.sizeAlarm ? 'ok' : 'fail',
      fence.journal.ok
        ? fence.journal.sizeAlarm
          ? 'The execution journal is over its size alarm'
          : 'The execution journal is healthy'
        : 'The execution journal cannot be read',
    )
    const running = this.db.read((sqlite) => this.capacityUsed(sqlite))
    add(
      'capacity',
      running < ORCH_CAPACITY.runningOrchestrations ? 'ok' : 'fail',
      `${running} of ${ORCH_CAPACITY.runningOrchestrations} runs are using capacity`,
    )
    const steps = stepBudgetOf(found)
    const defaultSteps =
      reports.size > 0
        ? defaultCodingSteps(found, codingNodeIdsOf(found.definition, team))
        : undefined
    const reserve = workflowReserve(
      steps,
      defaultSteps === undefined ? 0 : codingItemsFor(steps, defaultSteps),
      defaultSteps === undefined ? 0 : codingUnsentBytes(steps, maxConcurrentSteps),
    )
    const fits = this.db.read((sqlite) => this.quotaUsed(sqlite) + reserve <= this.quotaBytes)
    add(
      'quota',
      fits ? 'ok' : 'fail',
      fits ? 'There is room for another run' : 'Run storage is full; remove old runs first',
    )
    const preflight: WorkflowPreflight = {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
      issues: validation.issues,
      mapping,
      workers: [...reports].map(([agentId, report]) => ({
        agentId,
        runtime: known.get(agentId)!.runtime as 'claude-code' | 'codex',
        readiness: report.readiness,
        detail: report.detail,
        policyId: report.policyId,
        reach: report.reach,
        reachBeyondWorkspace: report.reachBeyondWorkspace,
      })),
      gatePolicyNotes: {
        'gates-only':
          'Only gate nodes stop for you; agent steps start as soon as their inputs are ready.',
        'every-step': 'You approve every agent step before it starts, as well as the gate nodes.',
      },
      acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
      spendNote: `Hermes reports tokens, often not dollars. Unknown cost is shown as unknown, never as zero, and spend of a live Hermes run is not settled: reservations are held until the run ends.${
        reports.size > 0
          ? ' Claude Code reports an estimated cost and Codex reports none; a coding step that ends without a cost counts as unknown cost.'
          : ''
      }`,
      maxSteps: found.maxSteps,
      reserveBytes: reserve,
      defaults: {
        gatePolicy: 'gates-only',
        maxConcurrentSteps: 2,
        stepEstimateUsd: 0.5,
        ...(defaultSteps === undefined ? {} : { codingSteps: defaultSteps }),
      },
    }
    return { preflight, reports }
  }

  async createWorkflowRun(
    body: WorkflowRunCreate,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
  ): Promise<WorkflowRunCreated> {
    const found = this.db.read((sqlite) => readVersion(sqlite, body.workflowId, body.version))
    validateInputs(found, body.inputs)
    // A definition the team or the host can't run (7.7c §1) gets the same answer as at save: structured issues.
    const validation = await this.validateWorkflow(found.definition, agents)
    if (!validation.ok)
      throw new HttpError(
        422,
        'invalid_definition',
        'This workflow can’t start as it is. Fix the problems and save a new version.',
        { result: validation },
      )
    const { preflight, reports } = await this.workflowPreflightWith(
      body.workflowId,
      body.version,
      agents,
      body.maxConcurrentSteps,
    )
    // A workflow with no coding step node sends and stores no coding fields at all (7.7c §1).
    if (
      reports.size === 0 &&
      (body.codingPolicies !== undefined ||
        body.acknowledgeCodingReach !== undefined ||
        body.acceptUnknownCost !== undefined ||
        body.codingSteps !== undefined ||
        body.quotaFloorPercent !== undefined)
    )
      throw new HttpError(
        400,
        'bad_request',
        'This workflow has no coding agents, so it takes no coding settings.',
      )
    if (!preflight.ok) {
      const failed = (id: string) =>
        preflight.checks.some((check) => check.id === id && check.status === 'fail')
      const details = { checks: preflight.checks }
      if (failed('global_fence'))
        throw new HttpError(
          409,
          'fenced',
          'New runs can’t start until you review the runs that need checking on Now.',
          details,
        )
      if (failed('capacity'))
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity.', details)
      if (failed('quota'))
        throw new HttpError(409, 'quota_exhausted', 'Score has no storage left for runs.', details)
      throw new HttpError(409, 'preflight_failed', 'The check before the run failed.', details)
    }
    // Consent is by policy id (7.7b §4, 7.7c §2): the id the person saw must still be the agent's, and a reach beyond the
    // workspace needs the acknowledgement of exactly that id. A rerun asks again; nothing carries over from the earlier run.
    for (const agentId of Object.keys(body.codingPolicies ?? {}))
      if (!reports.has(agentId))
        throw new HttpError(
          400,
          'bad_request',
          `${agentId} is not a coding agent of this workflow.`,
        )
    for (const [agentId, report] of reports) {
      const seen = body.codingPolicies?.[agentId]
      if (seen === undefined)
        throw new HttpError(
          400,
          'bad_request',
          `The request has to name the settings it was approved with for ${agentId}.`,
        )
      if (seen !== report.policyId)
        throw new HttpError(
          409,
          'policy_changed',
          `${agentId} changed since you looked. Check what it can reach and start again.`,
          { agentId, currentPolicyId: report.policyId },
        )
      if (
        report.reachBeyondWorkspace &&
        !body.acknowledgeCodingReach?.policyIds.includes(report.policyId!)
      )
        throw new HttpError(
          409,
          'reach_not_acknowledged',
          `${agentId} can read beyond its workspace. Accept that before the run starts.`,
          { agentId, policyId: report.policyId },
        )
    }
    const coding =
      reports.size > 0
        ? {
            reports,
            codingSteps: body.codingSteps ?? preflight.defaults.codingSteps ?? 1,
          }
        : undefined
    const id = `orc-${randomUUID().slice(0, 8)}`
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      if (isFenced(sqlite))
        throw new HttpError(
          409,
          'fenced',
          'New runs can’t start until you review the runs that need checking on Now.',
        )
      if (this.capacityUsed(sqlite) >= ORCH_CAPACITY.runningOrchestrations)
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity.')
      const steps = stepBudgetOf(found)
      const reserve = workflowReserve(
        steps,
        coding === undefined ? 0 : codingItemsFor(steps, coding.codingSteps),
        coding === undefined ? 0 : codingUnsentBytes(steps, body.maxConcurrentSteps),
      )
      if (this.quotaUsed(sqlite) + reserve > this.quotaBytes)
        throw new HttpError(409, 'quota_exhausted', 'Score has no storage left for this run.')
      if (body.deadlineAt !== undefined && body.deadlineAt <= now)
        throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
      // The person must have seen the incarnations the run will be bound to.
      const shown = new Map(body.agentMap.map((entry) => [entry.agentId, entry.incarnation]))
      for (const entry of preflight.mapping) {
        const current = lifecycleOf(sqlite, entry.agentId)?.incarnation_id ?? 'untracked'
        if (shown.get(entry.agentId) !== current || shown.size !== preflight.mapping.length)
          throw new HttpError(
            409,
            'conflict',
            `${entry.agentId} changed. Look at the start screen again.`,
          )
      }
      insertWorkflowRun(ctx, id, body, found, preflight, coding)
    })
    this.kick()
    return { run: this.workflowSummary(id), preflight }
  }

  private async decideWf(id: string, fn: (ctx: Ctx) => void): Promise<WorkflowRunSummary> {
    this.db.read((sqlite) => this.requireWorkflowOrch(sqlite, id))
    await this.mutate((ctx) => {
      fn(ctx)
    })
    this.kick()
    return this.workflowSummary(id)
  }

  wfGateDecision(id: string, gateId: string, body: GateDecision) {
    const isNode = this.db.read(
      (sqlite) =>
        sqlite
          .prepare('SELECT 1 FROM wf_gates WHERE orchestration_id = ? AND id = ?')
          .get(id, gateId) !== undefined,
    )
    return this.decideWf(id, (ctx) =>
      isNode ? decideNodeGate(ctx, id, gateId, body) : decideGate(ctx, id, gateId, body),
    )
  }
  wfRetry(id: string, nodeId: string, body: WorkflowRetryDecision) {
    return this.decideWf(id, (ctx) => retryNode(ctx, id, nodeId, body))
  }
  wfTryAgain(id: string, nodeId: string, body: WorkflowTryAgainDecision) {
    return this.decideWf(id, (ctx) => tryAgain(ctx, id, nodeId, body))
  }
  async wfRemap(id: string, body: WorkflowRemapDecision) {
    this.db.read((sqlite) => this.requireWorkflowOrch(sqlite, id))
    // A coding agent's new version is judged on its policy as it is now (the report is asked before the transaction).
    const isCoding = this.db.read(
      (sqlite) => readWorkerPolicy(sqlite, id, body.agentId) !== undefined,
    )
    const report = isCoding ? await this.options.codingFacts?.report(body.agentId) : undefined
    return this.decideWf(id, (ctx) =>
      remapWorkflow(ctx, id, body, this.options.fence.journal, report),
    )
  }
  /**
   * "Use the new settings" for a coding node (7.7c §4): the node's agent is unchanged, its step's one suspended attempt takes
   * the agent's current policy, through the same per-step remap and re-admission as an orchestration step (7.7b §12a).
   */
  async wfPolicyRemap(id: string, nodeId: string, body: WorkflowPolicyRemapDecision) {
    const agentId = this.db.read((sqlite) => {
      this.requireWorkflowOrch(sqlite, id)
      const def = requireWfRun(sqlite, id).definition.nodes.find((n) => n.id === nodeId)
      if (!def || def.kind !== 'agent')
        throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      return def.agentId
    })
    // Judged on the policy as it is now: the report is asked before the transaction.
    const report = await this.options.codingFacts?.report(agentId)
    return this.decideWf(id, (ctx) => {
      const node = nodesOf(ctx.sqlite, id).find((n) => n.node_id === nodeId)
      if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      if (node.revision !== body.expectedNodeRevision)
        throw new HttpError(409, 'conflict', 'The step changed while you were looking.', {
          currentRevision: node.revision,
        })
      if (node.step_id === null)
        throw new HttpError(409, 'conflict', 'This step isn’t waiting for new settings.')
      policyRemapStep(
        ctx,
        id,
        node.step_id,
        {
          agentId,
          policyId: body.policyId,
          ...(body.acknowledgeCodingReach === undefined
            ? {}
            : { acknowledgeCodingReach: body.acknowledgeCodingReach }),
          orchestrationRevision: body.orchestrationRevision,
        },
        report,
      )
    })
  }
  /** The answer to a held coding node (8.6): the node's step is the one the decision names. */
  wfQuotaDecision(id: string, nodeId: string, body: QuotaDecision) {
    return this.decideWf(id, (ctx) => {
      const node = nodesOf(ctx.sqlite, id).find((n) => n.node_id === nodeId)
      if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      if (node.step_id === null)
        throw new HttpError(409, 'conflict', 'This step isn’t held for a low limit.')
      answerQuota(ctx, id, node.step_id, body)
    })
  }
  wfLimits(id: string, body: LimitsDecision) {
    return this.decideWf(id, (ctx) => setLimits(ctx, id, body, this.storageFits))
  }
  wfPause(id: string, body: RunControl) {
    return this.decideWf(id, (ctx) => pauseRun(ctx, id, body))
  }
  wfResume(id: string, body: RunControl) {
    return this.decideWf(id, (ctx) => resumeRun(ctx, id, body))
  }
  wfStop(id: string) {
    return this.decideWf(id, (ctx) => stopRun(ctx, id))
  }
  wfWaiver(id: string, body: WaiverDecision) {
    return this.decideWf(id, (ctx) => grantWaiver(ctx, id, body))
  }
  wfAbandon(id: string, body: AbandonDecision) {
    return this.decideWf(id, (ctx) => abandonAttempts(ctx, id, body))
  }

  /**
   * An agent became ready again (a version check or gateway reachability recovered): attempts waiting out a refusal
   * backoff are tried at once, and every run with waiting work is re-evaluated (v8.2 item 1).
   */
  async agentReady(agentId: string): Promise<void> {
    await this.mutate((ctx) => {
      ctx.sqlite
        .prepare(
          "UPDATE orc_attempts SET next_try_at = NULL, refused_streak = 0 WHERE agent_id = ? AND state = 'created' AND needs_person = 0",
        )
        .run(agentId)
      bumpAdmission(ctx.sqlite)
      for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
    })
    this.kick()
  }

  /** Raised by routes that change a hold the executor does not see itself (team / agent Resume). */
  async admissionChanged(): Promise<void> {
    await this.mutate((ctx) => {
      bumpAdmission(ctx.sqlite)
      for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
    })
    this.kick()
  }

  // ------------------------------------------------------------------------------------------------------ MCP tools

  /** One `orch.*` call from the MCP server. `agentId` is the token's agent. */
  async handleTool(agentId: string, tool: ToolName, raw: unknown): Promise<ToolResult> {
    const parsed = parseToolArgs(tool, raw)
    if (!parsed.ok)
      return {
        kind: 'receipt',
        receipt: { status: 'refused', code: 'bad_arguments', message: parsed.message, tool },
      }
    // Nothing the lead sends may carry a capability (ids, agents, text): it would be stored or reflected in a receipt.
    if (valueHasCapability(parsed.args, ['capability']))
      return {
        kind: 'receipt',
        receipt: {
          status: 'refused',
          code: 'capability_in_text',
          message: 'A field contains something shaped like a capability; remove it',
          tool,
        },
      }
    if (tool === 'orch.assign' && typeof parsed.args.agent === 'string') {
      const isAntigravity = this.db.read(
        (sqlite) => getCodingAgent(sqlite, parsed.args.agent as string)?.runtime === 'antigravity',
      )
      if (isAntigravity) await this.options.codingFacts?.quota?.refresh().catch(() => undefined)
    }
    const outcome = await this.mutate((ctx) =>
      runCommand(ctx, agentId, tool, parsed.args, {
        commandsPerAttempt: ORCH_LIMITS.commandsPerLeadAttempt,
      }),
    )
    if (outcome.kind === 'unauthorized') return outcome
    if (outcome.changed) this.kick()
    return outcome
  }

  // ----------------------------------------------------------------------------------------------------- recovery

  /**
   * After a restart: an attempt whose admission was started but whose handle was never recorded is `unknown` and is
   * never replayed (design v3); attempts never sent (`created`) are dispatched again with a fresh capability.
   */
  /**
   * Upgrade repair (fix-i 2): migration 0049 turned attempts that ended on recovered session text into `unknown` but
   * left a result already accepted from them in place, where it kept satisfying dependencies (also after Abandon). The
   * text stays in the history; the step stops being a success, a run that finished on it is no longer clean, and a
   * dependent that was waiting on it is withdrawn. Idempotent: it only touches a `succeeded` step.
   */
  private repairRecoveredResults(ctx: Ctx): void {
    const { sqlite, now } = ctx
    for (const o of listOrchs(sqlite)) {
      const attempts = attemptsOf(sqlite, o.id)
      const steps = stepsOf(sqlite, o.id)
      let changed = false
      for (const step of steps) {
        if (step.status !== 'succeeded') continue
        const mine = attempts.filter((a) => a.step_id === step.id)
        const last = mine.reduce<AttemptRow | undefined>(
          (best, a) => (!best || a.n > best.n ? a : best),
          undefined,
        )
        if (
          !last ||
          last.unknown_reason !== 'recovered_text_only' ||
          !['unknown', 'abandoned'].includes(last.state)
        )
          continue
        changed = true
        const abandoned = last.state === 'abandoned'
        sqlite
          .prepare(
            'UPDATE orc_steps SET status = ?, disposition = ?, result = NULL, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?',
          )
          .run(
            abandoned ? 'failed' : 'unknown',
            abandoned ? 'stopped waiting: not confirmed as ended' : 'recovered_text_only',
            now,
            o.id,
            step.id,
          )
        const viaGraph = new Set(
          (
            sqlite
              .prepare(
                'SELECT DISTINCT step_id FROM wf_consumed WHERE orchestration_id = ? AND producer_step = ?',
              )
              .all(o.id, step.id) as { step_id: string }[]
          ).map((row) => row.step_id),
        )
        sqlite
          .prepare(
            'UPDATE wf_consumed SET withdrawn = 1 WHERE orchestration_id = ? AND producer_step = ?',
          )
          .run(o.id, step.id)
        const consumers = steps.filter((c) => c.after_steps.includes(step.id) || viaGraph.has(c.id))
        const sentConsumers: { stepId: string; status: string }[] = []
        for (const consumer of consumers) {
          const latest = attemptsOf(sqlite, o.id)
            .filter((a) => a.step_id === consumer.id)
            .reduce<AttemptRow | undefined>(
              (best, a) => (!best || a.n > best.n ? a : best),
              undefined,
            )
          const unsent = latest?.state === 'created' && !this.journaledSend(ctx, latest.id)
          if (
            latest &&
            !unsent &&
            ['created', 'send_started', 'running', 'unknown'].includes(latest.state)
          ) {
            // Possibly sent: its obligations are unchanged; only recorded.
            sentConsumers.push({ stepId: consumer.id, status: consumer.status })
            continue
          }
          if (
            consumer.status === 'queued' ||
            consumer.status === 'pending_gate' ||
            (consumer.status === 'admitted' && unsent)
          ) {
            if (unsent && latest) {
              // Retired before it can ever be sent; its frozen input held the withdrawn text.
              refuseAttempt(
                sqlite,
                latest,
                'input_withdrawn: a result it consumed was withdrawn',
                now,
              )
              sqlite
                .prepare("UPDATE orc_attempts SET input = '[input withdrawn]' WHERE id = ?")
                .run(latest.id)
            }
            // An approval given on the strength of that result no longer stands.
            sqlite
              .prepare(
                "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
              )
              .run(now, o.id, consumer.id)
            setStepStatus(
              sqlite,
              o.id,
              consumer.id,
              'blocked',
              `input_withdrawn: ${step.id} only ended on recovered text`,
              now,
            )
            addCause(sqlite, o.id, 'step_blocked', consumer.id, now, `after ${step.id}`)
          }
        }
        addHistory(
          sqlite,
          o.id,
          'recovered_result_withdrawn',
          {
            stepId: step.id,
            attemptId: last.id,
            text: step.result ? redactBounded(step.result, 500) : null,
            consumers: consumers.map((c) => ({ stepId: c.id, status: c.status })),
            sentConsumers,
          },
          now,
        )
        if (abandoned) addCause(sqlite, o.id, 'step_abandoned', step.id, now)
      }
      if (!changed) continue
      // A run that ended believing in that result did not end cleanly.
      if (o.status === 'succeeded')
        sqlite
          .prepare(
            "UPDATE orchestrations SET status = 'finished_with_unresolved', end_reason = 'a result recovered from session text was withdrawn' WHERE id = ?",
          )
          .run(o.id)
      touch(ctx, o.id)
    }
  }

  /** Whether the journal (or an unreadable journal, failing closed) says the attempt may have been sent. */
  private journaledSend(ctx: Ctx, attemptId: string): boolean {
    const journaled = ctx.journal.readOwn()
    if (!journaled.ok) return true
    return journalDispatches(journaled.entries).get(attemptId)?.state === 'sent'
  }

  /**
   * v8.1 item 1: a run from before 0049 got its mapping from the agents' current incarnations when that migration ran,
   * which silently adopted a replacement made earlier. Where a mapping was never remapped and the agent's first attempt
   * recorded another incarnation, the recorded one is restored (journaled), so the replacement shows up as a Remap.
   * Idempotent. A run with no attempt keeps the incarnation it got at migration time.
   */
  private backfillLegacyMappings(ctx: Ctx): void {
    const { sqlite, now } = ctx
    for (const o of listOrchs(sqlite)) {
      if (isTerminalStatus(o.status)) continue
      const rows = sqlite
        .prepare(
          'SELECT agent_id, incarnation, updated_at FROM orc_agent_map WHERE orchestration_id = ?',
        )
        .all(o.id) as { agent_id: string; incarnation: string; updated_at: string }[]
      for (const row of rows) {
        if (row.updated_at !== o.created_at) continue
        const first = sqlite
          .prepare(
            'SELECT agent_incarnation FROM orc_attempts WHERE orchestration_id = ? AND agent_id = ? ORDER BY created_at, rowid LIMIT 1',
          )
          .get(o.id, row.agent_id) as { agent_incarnation: string } | undefined
        if (!first || first.agent_incarnation === row.incarnation) continue
        journalSoft(ctx, () =>
          ctx.journal.append({
            kind: 'remap',
            orchestrationId: o.id,
            agentId: row.agent_id,
            incarnation: first.agent_incarnation,
          }),
        )
        sqlite
          .prepare(
            'UPDATE orc_agent_map SET incarnation = ? WHERE orchestration_id = ? AND agent_id = ?',
          )
          .run(first.agent_incarnation, o.id, row.agent_id)
        addHistory(
          sqlite,
          o.id,
          'mapping_backfilled',
          { agentId: row.agent_id, from: row.incarnation, to: first.agent_incarnation },
          now,
        )
        touch(ctx, o.id)
      }
    }
  }

  async recover(): Promise<void> {
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      // 3.13: a check that was running when Score stopped went down with it: never a pass.
      for (const row of sqlite
        .prepare("SELECT id, orchestration_id FROM orc_checks WHERE outcome = 'running'")
        .all() as { id: string; orchestration_id: string }[]) {
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'interrupted', ended_at = ? WHERE id = ?")
          .run(now, row.id)
        addCause(
          sqlite,
          row.orchestration_id,
          'check_interrupted',
          row.id,
          now,
          'Score restarted while it ran',
        )
      }
      this.repairRecoveredResults(ctx)
      this.backfillLegacyMappings(ctx)
      for (const o of listOrchs(sqlite)) {
        if (isTerminalStatus(o.status)) continue
        for (const attempt of attemptsOf(sqlite, o.id))
          if (attempt.state === 'send_started' && isCodingStep(attempt)) {
            this.recoverCodingSend(ctx, o, attempt)
          } else if (attempt.state === 'send_started') {
            // The adapter may have committed the handle Hermes returned before Score recorded it: keep it, so the
            // run can be observed and a Stop delivered. The attempt is still never resent.
            const committed =
              (
                sqlite
                  .prepare(
                    "SELECT result FROM command_intents WHERE idempotency_key = ? AND state = 'accepted' AND result IS NOT NULL",
                  )
                  .get(attempt.turn_id) as { result: string } | undefined
              )?.result ??
              (
                sqlite
                  .prepare('SELECT id FROM runs WHERE score_turn_id = ?')
                  .get(attempt.turn_id) as { id: string } | undefined
              )?.id
            if (committed) {
              sqlite
                .prepare(
                  "UPDATE orc_attempts SET run_id = ?, state = 'running', updated_at = ? WHERE id = ? AND run_id IS NULL",
                )
                .run(committed, now, attempt.id)
              journalSoft(ctx, () =>
                ctx.journal.append({ kind: 'run_handle', attemptId: attempt.id, runId: committed }),
              )
              addHistory(
                sqlite,
                o.id,
                'recovered_handle',
                { attemptId: attempt.id, runId: committed },
                now,
              )
              continue
            }
            this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
            addHistory(sqlite, o.id, 'recovered_unknown', { attemptId: attempt.id }, now)
          }
        touch(ctx, o.id)
      }
    })
  }

  /**
   * Restart matrix, a coding generation that was `send_started` and has no handle (design §10). If the coding runtime
   * committed the run for this generation's turn, the handle is kept and the run's own end (interrupted by recovery)
   * decides. Otherwise the pre-minted launch id says what ran: absent from the coding journal (or revoked before
   * `releasing`) proves nothing launched and the generation is closed with cause `restart`; anything else is unknown.
   */
  private recoverCodingSend(ctx: Ctx, o: OrchRow, attempt: AttemptRow): void {
    const { sqlite, now } = ctx
    // A frozen home writes no journal record: the generation waits for reset-history (decision 71).
    if (this.options.fence.executionFrozenIn(sqlite) !== null) return
    const generation = readGeneration(sqlite, attempt.id, attempt.dispatch_generation)
    if (!generation) return void this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
    const committed =
      (
        sqlite
          .prepare(
            "SELECT result FROM command_intents WHERE idempotency_key = ? AND state = 'accepted' AND result IS NOT NULL",
          )
          .get(generation.turn_id) as { result: string } | undefined
      )?.result ??
      (
        sqlite.prepare('SELECT id FROM runs WHERE score_turn_id = ?').get(generation.turn_id) as
          { id: string } | undefined
      )?.id
    if (committed) {
      sqlite
        .prepare(
          "UPDATE orc_attempts SET run_id = ?, state = 'running', updated_at = ? WHERE id = ? AND run_id IS NULL",
        )
        .run(committed, now, attempt.id)
      sqlite
        .prepare(
          'UPDATE orc_generations SET run_id = COALESCE(run_id, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(committed, attempt.id, generation.generation)
      journalSoft(ctx, () =>
        ctx.journal.append({
          kind: 'run_handle',
          attemptId: attempt.id,
          runId: committed,
          generation: generation.generation,
        }),
      )
      addHistory(sqlite, o.id, 'recovered_handle', { attemptId: attempt.id, runId: committed }, now)
      return
    }
    const facts = launchFacts(sqlite, ctx.journal, generation.launch_id)
    if (facts.kind !== 'unreadable' && provenNoLaunch(facts)) {
      this.closeCoding(
        ctx,
        o,
        attempt,
        generation.generation,
        facts.kind === 'known' && facts.revokeCause ? facts.revokeCause : 'restart',
      )
      addHistory(sqlite, o.id, 'recovered_closed', { attemptId: attempt.id }, now)
      return
    }
    this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
    addHistory(sqlite, o.id, 'recovered_unknown', { attemptId: attempt.id }, now)
  }

  private markUnknown(ctx: Ctx, o: OrchRow, attempt: AttemptRow, reason: string): void {
    const { sqlite, now } = ctx
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'unknown', unknown_reason = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason, now, attempt.id)
    if (attempt.step_id) {
      const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
      if (step && step.status === 'admitted') {
        setStepStatus(sqlite, o.id, step.id, 'unknown', reason, now)
        addCause(sqlite, o.id, 'step_unknown', step.id, now, reason)
      }
    } else addCause(sqlite, o.id, 'lead_unknown', attempt.id, now, reason)
    touch(ctx, o.id)
  }

  // ----------------------------------------------------------------------------------------------------- settling

  /** Per-run housekeeping done after every transaction that touched the run. Returns whether the status changed. */
  private settle(ctx: Ctx, orchId: string): boolean {
    const { sqlite, now } = ctx
    let o = readOrch(sqlite, orchId)
    if (!o || isTerminalStatus(o.status)) return false
    cascadeBlocked(sqlite, orchId, now)
    // 3.15–3.16: a finished scan starts the lead; a vote whose answers have ended is tallied.
    settleHelpers(ctx, o)
    // A workflow run's planner is its graph: it runs inside the transaction of whatever woke the run.
    if (o.planner === 'workflow') {
      const planned = planWorkflow(ctx, o)
      o = readOrch(sqlite, orchId) ?? o
      if (planned && o.status !== 'running') touch(ctx, orchId)
    }
    const attempts = attemptsOf(sqlite, orchId)
    // A suspended attempt (agent changed, limit reached) holds no slot and does not keep the run alive.
    const live = attempts.some(
      (a) => !a.suspended && ['created', 'send_started', 'running'].includes(a.state),
    )
    const end = (status: OrchRow['status'], reason: string | null): boolean => {
      sqlite
        .prepare(
          'UPDATE orchestrations SET status = ?, pause_reason = NULL, ended_at = ?, end_reason = ? WHERE id = ?',
        )
        .run(status, now, reason, orchId)
      addHistory(sqlite, orchId, 'ended', { status, reason }, now)
      // Capacity and reservations of this run are released: waiting work elsewhere may be admissible now.
      bumpAdmission(sqlite)
      if (o!.planner === 'workflow') finalizeGraph(ctx, orchId, status)
      return true
    }
    // The deadline is a fence-and-drain: admission stops, queued work is retired, owed Stops go to every admitted attempt.
    if (
      (o.status === 'running' || o.status === 'paused') &&
      o.deadline_at !== null &&
      now >= o.deadline_at
    ) {
      stopRun(ctx, orchId, 'deadline')
      return true
    }
    if (o.status === 'stopping') {
      const unresolved = attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null)
      if (live || unresolved) return false
      // An unrouted failure is a fence-and-drain too, but its run ends `failed`, not `stopped`.
      const failedGraph =
        o.planner === 'workflow' && requireWfRun(sqlite, orchId).graph_outcome === 'failed'
      return failedGraph
        ? end('failed', o.end_reason ?? 'the graph failed')
        : end('stopped', o.end_reason ?? 'stopped by the person')
    }
    if (o.status === 'finishing') {
      if (live) return false
      if (attempts.some((a) => ['unknown', 'abandoned'].includes(a.state)))
        return end('finished_with_unresolved', 'attempts not confirmed ended')
      return o.finish_outcome === 'failed'
        ? end('failed', 'the lead finished with outcome failed')
        : end('succeeded', null)
    }
    if (o.status !== 'running') return false
    const steps = stepsOf(sqlite, orchId)
    const wakeSource =
      live ||
      (o.planner === 'workflow' &&
        nodesOf(sqlite, orchId).some((n) =>
          ['ready', 'gate_open', 'running', 'unresolved'].includes(n.state),
        )) ||
      (o.planner === 'lead' && causesAfter(sqlite, orchId, o.causes_consumed_up_to).length > 0) ||
      // A check queued or running ends with a cause that wakes the lead (3.13).
      checkPending(sqlite, orchId) ||
      steps.some((s) => ['pending_gate', 'queued', 'admitted'].includes(s.status)) ||
      inquiriesOf(sqlite, orchId).some((q) => q.status === 'open') ||
      gatesOf(sqlite, orchId).some((g) => g.status === 'open') ||
      attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null) ||
      // A coding step blocked with its suspended attempt waits for the person (settings, limit): that is on Needs you, not
      // a run nobody can wake (7.7b §12a).
      attempts.some((a) => a.suspended && a.state === 'created')
    if (!wakeSource) {
      this.pauseFor(ctx, o, 'no_wake_source')
      return true
    }
    return false
  }

  /** The periodic pass: touches every live run so deadlines and quiescence are noticed without any event. */
  private sweep(ctx: Ctx): void {
    for (const o of listOrchs(ctx.sqlite)) if (!isTerminalStatus(o.status)) touch(ctx, o.id)
  }

  // ---------------------------------------------------------------------------------------------------- admission

  private pauseFor(ctx: Ctx, o: OrchRow, reason: string): void {
    // A manual hold is never overwritten by a condition.
    if (o.manual_paused_at !== null) return
    ctx.sqlite
      .prepare("UPDATE orchestrations SET status = 'paused', pause_reason = ? WHERE id = ?")
      .run(reason, o.id)
    addHistory(ctx.sqlite, o.id, 'paused', { reason }, ctx.now)
    touch(ctx, o.id)
  }

  /**
   * The one admission authority. Creates attempts in `created` (a lead attempt claims the wake cursor and freezes its
   * input; a step transfers its reservation); sending them is `dispatch`, which re-checks everything.
   */
  private admit(ctx: Ctx): string[] {
    const { sqlite } = ctx
    // A frozen home (unresolved or copied installation, lost journal) dispatches nothing (decision 71).
    if (isFenced(sqlite) || this.options.fence.executionFrozenIn(sqlite) !== null) return []
    const counts = activeStepCounts(sqlite)
    for (const o of listOrchs(sqlite).reverse()) {
      // The manual hold is checked on its own, whatever the status says (fix-i 3).
      if (o.status !== 'running' || o.manual_paused_at !== null) continue
      if ((this.cooldown.get(o.id) ?? 0) > this.nowMs()) continue
      this.admitRun(ctx, o, counts)
    }
    // Everything admitted and not yet sent, including attempts that waited out a pause or a fence.
    return z
      .array(z.object({ id: z.string(), orchestration_id: z.string() }))
      .parse(
        sqlite
          .prepare(
            `SELECT a.id, a.orchestration_id FROM orc_attempts a JOIN orchestrations o ON o.id = a.orchestration_id
             WHERE a.state = 'created' AND a.suspended = 0 AND o.status IN ('running', 'stopping', 'finishing') ORDER BY a.created_at, a.rowid`,
          )
          .all(),
      )
      .filter((row) => (this.cooldown.get(row.orchestration_id) ?? 0) <= this.nowMs())
      .map((row) => row.id)
  }

  private admitRun(ctx: Ctx, o: OrchRow, counts: ReturnType<typeof activeStepCounts>): void {
    const { sqlite, now } = ctx
    const attempts = attemptsOf(sqlite, o.id)
    if (unknownFenceAttempts(o, attempts).length > 0 || cancelFenceAttempts(o, attempts).length > 0)
      return
    if (o.deadline_at !== null && now >= o.deadline_at) return
    const view = budgetView(sqlite, o)
    if (overBudget(view)) return this.pauseFor(ctx, o, 'budget')
    if (unknownCostBlocks(sqlite, o, view)) return this.pauseFor(ctx, o, 'unknown_spend')
    if (teamPausedAt(sqlite) !== null) return

    const steps = stepsOf(sqlite, o.id)
    let leadLive = attempts.some(
      (a) => a.kind === 'lead' && ['created', 'send_started', 'running'].includes(a.state),
    )
    const pending = causesAfter(sqlite, o.id, o.causes_consumed_up_to)
    if (o.planner === 'lead' && !leadLive && pending.length > 0) {
      const lead = leadOf(o)
      const life = lifecycleOf(sqlite, lead.agentId)
      const incarnation = life?.incarnation_id ?? 'untracked'
      if (incarnation !== lead.incarnation || !agentAdmits(sqlite, lead.agentId))
        return this.pauseFor(ctx, o, 'agent_unavailable')
      if (o.lead_turns_used >= o.max_lead_turns) return this.pauseFor(ctx, o, 'turns_exhausted')
      if (o.consecutive_lead_failures >= 2) return this.pauseFor(ctx, o, 'lead_failing')
      if (!canReserve(view, o.lead_turn_estimate_usd)) return this.pauseFor(ctx, o, 'budget')
      if (agentPausedAt(sqlite, lead.agentId) === null) {
        const turn = o.lead_turns_used + 1
        const n = attempts.filter((a) => a.kind === 'lead').length + 1
        const attemptId = `orc-${o.id.slice(4)}-lead-${n}`
        const claimTo = pending.at(-1)!.id
        const input = renderLeadInput({
          o: { ...o, lead_turns_used: turn },
          turn,
          steps,
          gates: gatesOf(sqlite, o.id),
          inquiries: inquiriesOf(sqlite, o.id),
          causes: pending,
          budget: view,
          now,
          check: this.leadCheck(sqlite, o.id),
          helperLines: helperLines(sqlite, o),
        })
        if (!input.includes(ORC_CAPABILITY_PLACEHOLDER))
          throw new Error('Lead input lost its capability placeholder')
        this.insertAttempt(ctx, o, {
          id: attemptId,
          kind: 'lead',
          stepId: null,
          n,
          agentId: lead.agentId,
          incarnation,
          input,
          reserved: o.lead_turn_estimate_usd,
          claim: { from: o.causes_consumed_up_to, to: claimTo },
        })
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used + 1 WHERE id = ?',
          )
          .run(claimTo, o.id)
        addStored(sqlite, o.id, Buffer.byteLength(input))
        leadLive = true
        touch(ctx, o.id)
      }
    }
    const byId = new Map(steps.map((s) => [s.id, s]))
    // Coding attempts that are prepared and not finished (waiting, in flight or blocked for a decision) keep their frozen
    // input; their number is bounded apart from the launch limit, and the in-flight ones count so a burst can't exceed it.
    let unsentCoding = attempts.filter(
      (a) =>
        a.kind === 'step' &&
        a.runtime !== 'hermes' &&
        ['created', 'send_started', 'running', 'unknown'].includes(a.state),
    ).length
    for (const step of steps) {
      if (step.status !== 'queued') continue
      // A lead-asks step waits until the turn that created it ends, so the lead can ask for approval first.
      if (o.gate_policy === 'lead-asks' && leadLive) continue
      if (!step.after_steps.every((id) => byId.get(id)?.status === 'succeeded')) continue
      // A result that only ever ended on recovered text is history, never an input (fix-i 2).
      if (step.after_steps.some((id) => recoveredOnly(attempts, id))) continue
      const life = lifecycleOf(sqlite, step.agent_id)
      if ((life?.incarnation_id ?? 'untracked') !== step.agent_incarnation) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'blocked',
          'agent_unavailable: the agent was replaced or removed',
          now,
        )
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'agent_unavailable')
        touch(ctx, o.id)
        continue
      }
      // The step must also match the mapping the person started (or remapped) the run with.
      const frozen = frozenIncarnation(sqlite, o.id, step.agent_id)
      if (frozen !== undefined && frozen !== step.agent_incarnation) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'blocked',
          'agent_changed: not the agent mapping approved for this run',
          now,
        )
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'agent_changed')
        touch(ctx, o.id)
        continue
      }
      if (!agentAdmits(sqlite, step.agent_id) || agentPausedAt(sqlite, step.agent_id) !== null)
        continue
      // 3.15: helper work and vote answers have their own slots; the lead's limit is for its own steps.
      const helperConfig = usesHelperSlot(step) ? helpersOf(o) : null
      const slot = helperConfig ? `${o.id}#helpers` : o.id
      if ((counts.perRun.get(slot) ?? 0) >= (helperConfig?.maxConcurrent ?? o.max_concurrent_steps))
        continue
      if (counts.total >= ORCH_CAPACITY.concurrentSteps) continue
      if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent) continue
      // The quota guard (8.6): a coding agent below its floor takes no new step; the step is held and the person asked.
      // Missing or expired readings never hold; a step that already runs is never touched.
      if (!quotaAdmits(ctx, this.options.codingFacts?.quota, o, step)) {
        this.wakeAtReset(ctx, o.id, step.id)
        continue
      }
      const dependencies = step.after_steps.map((id) => byId.get(id)!)
      // A workflow step's instruction already is the final, validated payload (it is never re-rendered or clipped).
      const input =
        o.planner === 'workflow' ? step.instruction : renderStepInput({ o, step, dependencies })
      // Scanned after rendering and before anything is stored: a capability in a step input blocks admission.
      if (containsCapability(input) || containsCapability(step.instruction)) {
        setStepStatus(sqlite, o.id, step.id, 'blocked', 'capability_in_input', now)
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'capability_in_input')
        touch(ctx, o.id)
        continue
      }
      // A step that was blocked with a suspended attempt (agent changed, limit reached) goes on with that SAME attempt:
      // one active attempt per step, its reservation and frozen input kept (7.7b §12a). It is admitted again through the
      // same rules; its policy id is the one the step is approved for now.
      const suspended = attempts.findLast((a) => a.step_id === step.id && a.suspended)
      if (suspended) {
        sqlite
          .prepare(
            'UPDATE orc_attempts SET suspended = 0, policy_id = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            // The step keeps the settings it was approved with (set at its own remap); the worker's stored mapping may
            // have moved on for another step, and admission then blocks this one until it is remapped itself (F2 #3).
            suspended.policy_id ?? readWorkerPolicy(sqlite, o.id, step.agent_id)?.policyId ?? null,
            now,
            suspended.id,
          )
        setStepStatus(sqlite, o.id, step.id, 'admitted', null, now)
        counts.perRun.set(slot, (counts.perRun.get(slot) ?? 0) + 1)
        counts.perAgent.set(step.agent_id, (counts.perAgent.get(step.agent_id) ?? 0) + 1)
        counts.total++
        touch(ctx, o.id)
        continue
      }
      // A coding step is parked, with nothing prepared or retained, while the run's room for unsent inputs is used up (the
      // slots, or the partition's bytes): it goes on when an attempt is sent or settled, or the person raises the limit
      // that grows the partition (7.7c F1 #6). Retaining it anyway would spill into the control reserve.
      const codingStep = runtimeOfAgent(sqlite, step.agent_id) !== 'hermes'
      if (codingStep) {
        const fresh = readOrch(sqlite, o.id) ?? o
        if (
          unsentCoding >=
            codingUnsentSlots(
              o.max_steps +
                (helpersOf(o)?.maxSteps ?? 0) +
                (o.advisor_agent_id ? ADVISOR_STEPS : 0),
              o.max_concurrent_steps + (helpersOf(o)?.maxConcurrent ?? 0),
            ) ||
          fresh.coding_stored_bytes + Buffer.byteLength(input) > fresh.coding_reserve_bytes
        )
          continue
        unsentCoding++
      }
      const n = attempts.filter((a) => a.step_id === step.id).length + 1
      const attemptId = `orc-${o.id.slice(4)}-${step.id}-${n}`
      this.insertAttempt(ctx, o, {
        id: attemptId,
        kind: 'step',
        stepId: step.id,
        n,
        agentId: step.agent_id,
        incarnation: step.agent_incarnation,
        input,
        reserved: step.estimate_usd,
        claim: null,
      })
      addHistory(
        sqlite,
        o.id,
        'step_input_frozen',
        {
          attemptId,
          revisions: Object.fromEntries(dependencies.map((d) => [d.id, d.result_revision])),
        },
        now,
      )
      setStepStatus(sqlite, o.id, step.id, 'admitted', null, now)
      // A workflow step's input also lives in its reply row and its dispatch intent: every retained copy is charged.
      if (codingStep) addCodingStored(sqlite, o.id, Buffer.byteLength(input))
      else addStored(sqlite, o.id, Buffer.byteLength(input) * (o.planner === 'workflow' ? 3 : 1))
      counts.perRun.set(slot, (counts.perRun.get(slot) ?? 0) + 1)
      counts.perAgent.set(step.agent_id, (counts.perAgent.get(step.agent_id) ?? 0) + 1)
      counts.total++
      touch(ctx, o.id)
    }
  }

  /** Antigravity's quota is read from its CLI: refresh it (at most once a minute) when a queued step would use it. */
  private refreshQuota(): Promise<unknown> | undefined {
    const quota = this.options.codingFacts?.quota
    if (!quota) return undefined
    const needed = this.db.read((sqlite) =>
      listOrchs(sqlite).some(
        (o) =>
          o.status === 'running' &&
          stepsOf(sqlite, o.id).some(
            (step) =>
              step.status === 'queued' &&
              getCodingAgent(sqlite, step.agent_id)?.runtime === 'antigravity',
          ),
      ),
    )
    return needed ? quota.refresh().catch(() => undefined) : undefined
  }

  private insertAttempt(ctx: Ctx, o: OrchRow, a: NewAttempt): void {
    insertAttemptRows(ctx, o, a)
  }

  // ---------------------------------------------------------------------------------------------------- dispatch

  /**
   * Sends one admitted attempt. The transaction that starts the send re-checks every admission rule, mints the
   * capability (lead attempts), and journals `send_started` before it commits; only then is Hermes called. After this
   * point the admission is never replayed: any uncertainty makes the attempt `unknown`.
   */
  private async dispatch(attemptId: string): Promise<boolean> {
    let begun:
      | {
          attempt: AttemptRow
          capability?: string
          coding?: { generation: number; turnId: string; launchId: string }
        }
      | undefined
    try {
      begun = await this.mutate((ctx) => this.beginSend(ctx, attemptId))
    } catch (error) {
      // The journal could not record the send, so nothing was sent: fence rather than act without a record.
      this.err(error)
      this.fenceNow('journal_unwritable', error instanceof Error ? error.message : String(error))
      return false
    }
    if (!begun) return false
    const { attempt, capability, coding } = begun
    try {
      const result = await this.options.port.startRun({
        agentId: attempt.agent_id,
        input: attempt.input,
        turnId: coding?.turnId ?? attempt.turn_id,
        sessionId: attempt.session_id,
        owner: coding ? this.ownerOf(attempt, coding) : 'orchestration',
        ...(capability ? { render: (stored: string) => withCapability(stored, capability) } : {}),
      })
      await this.mutate((ctx) =>
        this.recordHandle(ctx, attempt.id, coding?.generation ?? null, result.runId),
      )
    } catch (error) {
      await this.mutate((ctx) =>
        this.recordSendFailure(ctx, attempt.id, error, coding?.generation ?? null),
      )
    }
    return true
  }

  /** The owner a coding launch carries: its generation's identity and the executor's decision at the ordering point. */
  private ownerOf(
    attempt: AttemptRow,
    coding: { generation: number; launchId: string },
  ): OrchestrationOwner {
    const { deadline, policy } = this.db.read((sqlite) => ({
      deadline: readOrch(sqlite, attempt.orchestration_id)?.deadline_at ?? null,
      policy: readWorkerPolicy(sqlite, attempt.orchestration_id, attempt.agent_id),
    }))
    return {
      kind: 'orchestration',
      orchestrationId: attempt.orchestration_id,
      attemptId: attempt.id,
      generation: coding.generation,
      launchId: coding.launchId,
      deadlineAt: deadline === null ? null : Date.parse(deadline),
      // The invocation is built from this stored policy, never from the live agent row (7.7b §3).
      ...(policy ? { policy: { id: policy.policyId, policy: policy.policy } } : {}),
      // Its own read transaction, inside the release critical section. Never writes, never awaits (design §6).
      authorise: (prepared, journal) =>
        this.db.read((sqlite) =>
          this.decideRelease(sqlite, {
            orchestrationId: attempt.orchestration_id,
            attemptId: attempt.id,
            generation: coding.generation,
            launchId: coding.launchId,
            expiry: prepared.expiry,
            policyId: prepared.policyId,
            executed: journal.executedBy(attempt.orchestration_id),
          }),
        ),
    }
  }

  private beginSend(
    ctx: Ctx,
    attemptId: string,
  ):
    | {
        attempt: AttemptRow
        capability?: string
        coding?: { generation: number; turnId: string; launchId: string }
      }
    | undefined {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'created' || attempt.suspended) return undefined
    // Fresh run facts first (another dispatch may have been awaiting its reply while a sibling's run ended or was
    // recovered): every fence and hold below is judged on what reconciliation just established (fix-i 1).
    this.reconcileAttempts(ctx)
    const o = requireOrch(sqlite, attempt.orchestration_id)
    // The journal outlives the database: if it says this attempt's latest dispatch generation was sent, it is never sent
    // again. A proven refusal (`send_refused`) of that generation leaves it sendable as the next generation.
    const journaled = ctx.journal.readOwn()
    // Without a readable journal we can't prove this attempt was never sent: fail closed (the caller fences).
    if (!journaled.ok) throw new Error(`Execution journal is unreadable: ${journaled.reason}`)
    const dispatched = journalDispatches(journaled.entries).get(attempt.id)
    if (dispatched?.state === 'sent') {
      applyJournalEvidence(sqlite, journaled.entries, now)
      touch(ctx, o.id)
      return undefined
    }
    const refuse = (reason: string, step?: { status: StepRow['status']; disposition: string }) => {
      refuseAttempt(sqlite, attempt, reason, now)
      if (attempt.step_id && step)
        setStepStatus(sqlite, o.id, attempt.step_id, step.status, step.disposition, now)
      touch(ctx, o.id)
      return undefined
    }
    // The common admission rules, asked once (the release decision asks the same function). What each cause means for a
    // send: the first group ends the attempt, the second keeps it `created` until the condition clears.
    const denial = admissionDenial(sqlite, this.options.fence, o, attempt, now)
    if (denial && ['retired', 'cancel', 'stop'].includes(denial.cause))
      return refuse(`not dispatched: run ${o.status}`, {
        status: 'not_started',
        disposition: `not_started: run ${o.status}`,
      })
    // Result eligibility of everything the input consumed, judged at send (fix-j 2).
    if (denial?.cause === 'inputs_withdrawn') {
      const withdrawn = denial.withdrawn!
      refuseAttempt(sqlite, attempt, `input_withdrawn: ${withdrawn}`, now)
      sqlite
        .prepare(
          "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
        )
        .run(now, o.id, attempt.step_id!)
      setStepStatus(sqlite, o.id, attempt.step_id!, 'blocked', `input_withdrawn: ${withdrawn}`, now)
      addCause(sqlite, o.id, 'step_blocked', attempt.step_id!, now, 'input_withdrawn')
      touch(ctx, o.id)
      return undefined
    }
    // The input is exactly what was frozen and, for workflows, approved: the dispatched bytes hash to the frozen hash.
    if (attempt.kind === 'step' && attempt.step_id) {
      const frozenStep = readStep(sqlite, o.id, attempt.step_id)
      if (
        frozenStep?.payload_hash &&
        createHash('sha256').update(attempt.input).digest('hex') !== frozenStep.payload_hash
      )
        return refuse('not dispatched: the input is not the approved payload', {
          status: 'blocked',
          disposition: 'payload_mismatch: the input is not the approved payload',
        })
    }
    // Refused dispatch generations: the person is needed at the lifetime limit; after five in a row the attempt waits.
    if (attempt.needs_person || (attempt.next_try_at !== null && attempt.next_try_at > now))
      return undefined
    // A coding step whose approved settings no longer match: it is suspended as it is (one attempt per step) and the
    // step waits for "Use the new settings" or a new approval (7.7b §12a). Nothing was sent.
    if (denial?.policy !== undefined && attempt.step_id) {
      sqlite
        .prepare('UPDATE orc_attempts SET suspended = 1, updated_at = ? WHERE id = ?')
        .run(now, attempt.id)
      setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', 'agent_changed', now)
      addCause(sqlite, o.id, 'step_blocked', attempt.step_id, now, 'agent_changed')
      touch(ctx, o.id)
      return undefined
    }
    if (denial?.cause === 'agent_changed') {
      if (attempt.kind === 'lead') {
        refuseAttempt(
          sqlite,
          attempt,
          denial.frozenMapping
            ? 'not dispatched: the lead agent mapping changed'
            : 'not dispatched: the lead agent changed',
          now,
        )
        // Nothing was sent, so the turn's causes go back to the wake cursor.
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
        this.pauseFor(ctx, o, 'agent_unavailable')
        return undefined
      }
      return denial.frozenMapping
        ? refuse('not dispatched: not the approved agent mapping', {
            status: 'blocked',
            disposition: 'agent_changed: not the agent mapping approved for this run',
          })
        : refuse('not dispatched: the agent changed', {
            status: 'blocked',
            disposition: 'agent_unavailable: the agent was replaced or removed',
          })
    }
    // Pauses, fences, holds, the deadline and a stop owed: the attempt stays `created`. The deadline flow, the budget
    // pause and the unknown-cost pause are the orchestration's own.
    if (denial?.cause === 'budget' || denial?.cause === 'unknown_cost') {
      this.pauseFor(
        ctx,
        requireOrch(sqlite, o.id),
        denial.cause === 'budget' ? 'budget' : 'unknown_spend',
      )
      return undefined
    }
    if (denial) return undefined
    let capability: string | undefined
    // Dispatch generation g: 1, 2, ... for a step attempt (never reused, even after a journaled refusal); the lead's is
    // its capability generation.
    let generation =
      attempt.kind === 'step'
        ? Math.max(attempt.dispatch_generation, dispatched?.generation ?? 0) + 1
        : 0
    if (attempt.kind === 'lead') {
      capability = mintCapability()
      generation =
        (
          sqlite
            .prepare('SELECT COUNT(*) AS n FROM orc_capabilities WHERE attempt_id = ?')
            .get(attempt.id) as { n: number }
        ).n + 1
      // A re-dispatch never reuses an earlier capability: the older generations expire here.
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attempt.id)
      sqlite
        .prepare(
          'INSERT INTO orc_capabilities (hash, attempt_id, generation, agent_id, agent_incarnation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          hashCapability(capability),
          attempt.id,
          generation,
          attempt.agent_id,
          attempt.agent_incarnation,
          now,
        )
    }
    // A coding worker's generation has its own turn id and launch id, minted here and journaled with the send (7.7b §5).
    let coding: { generation: number; turnId: string; launchId: string } | undefined
    if (attempt.kind === 'step' && attempt.runtime !== 'hermes') {
      if (generation > MAX_GENERATIONS && o.planner === 'workflow' && attempt.step_id) {
        // A workflow node's dispatch held back 20 times waits for the person where it is (7.7c §4): the attempt is
        // suspended, the node keeps its step, and Try again renews it. It is never refused and replaced by the planner.
        sqlite
          .prepare('UPDATE orc_attempts SET suspended = 1, updated_at = ? WHERE id = ?')
          .run(now, attempt.id)
        setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', 'held_back', now)
        touch(ctx, o.id)
        return undefined
      }
      if (generation > MAX_GENERATIONS) {
        // Held back again and again: the person decides, there is no automatic loop (design §5).
        refuseAttempt(sqlite, attempt, 'held_back_too_often', now)
        if (attempt.step_id) {
          setStepStatus(
            sqlite,
            o.id,
            attempt.step_id,
            'blocked',
            'kept being held back: it was prepared 20 times and never started',
            now,
          )
          addCause(sqlite, o.id, 'step_blocked', attempt.step_id, now, 'kept being held back')
        }
        touch(ctx, o.id)
        return undefined
      }
      coding = {
        generation,
        turnId: codingTurnId(attempt.turn_id, generation),
        launchId: randomUUID(),
      }
      this.openGeneration(ctx, attempt, coding)
    }
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'send_started', sent_at = ?, dispatch_generation = ?, next_try_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, generation, now, attempt.id)
    // Journal first (fsync'd) and last in the transaction: if it cannot be written the whole send is abandoned.
    ctx.journal.append({
      kind: 'send_started',
      attemptId: attempt.id,
      orchestrationId: o.id,
      attemptKind: attempt.kind,
      agentId: attempt.agent_id,
      generation,
      ...(coding ? { turnId: coding.turnId, launchId: coding.launchId } : {}),
    })
    touch(ctx, o.id)
    return {
      attempt: { ...attempt, state: 'send_started', dispatch_generation: generation },
      ...(capability ? { capability } : {}),
      ...(coding ? { coding } : {}),
    }
  }

  /** The generation's identity rows: its turn/launch ids and its own reply row (never the older generation's). */
  private openGeneration(
    ctx: Ctx,
    attempt: AttemptRow,
    coding: { generation: number; turnId: string; launchId: string },
  ): void {
    const { sqlite, now } = ctx
    const messageId = `reply:${coding.turnId}`
    sqlite
      .prepare(
        'INSERT INTO orc_generations (attempt_id, generation, turn_id, launch_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(attempt.id, coding.generation, coding.turnId, coding.launchId, messageId, now)
    // The first generation takes over the reply row insertAttempt reserved; later ones copy it, so every generation
    // streams into its own reply and the older one is only ever closed.
    const taken = sqlite
      .prepare(
        'UPDATE message_runs SET turn_id = ?, message_id = ?, generation = ? WHERE orchestration_attempt_id = ? AND generation IS NULL',
      )
      .run(coding.turnId, messageId, coding.generation, attempt.id)
    if (Number(taken.changes) === 0)
      sqlite
        .prepare(
          `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at, orchestration_attempt_id, generation)
           SELECT ?, room_id, agent_id, chain_id, hop, ?, parent_message_id, input, agents, ?, orchestration_attempt_id, ?
           FROM message_runs WHERE orchestration_attempt_id = ? ORDER BY generation DESC LIMIT 1`,
        )
        .run(messageId, coding.turnId, now, coding.generation, attempt.id)
    sqlite.prepare('UPDATE orc_attempts SET message_id = ? WHERE id = ?').run(messageId, attempt.id)
  }

  private recordHandle(
    ctx: Ctx,
    attemptId: string,
    generation: number | null,
    runId: string,
  ): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt) return
    const o = requireOrch(sqlite, attempt.orchestration_id)
    if (generation !== null) {
      // The handle belongs to one generation: it is kept as that generation's evidence, and it attaches to the attempt
      // only while that generation is the current one (7.7b §5). An older generation's run is never reattached.
      sqlite
        .prepare(
          'UPDATE orc_generations SET run_id = COALESCE(run_id, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(runId, attemptId, generation)
      journalSoft(ctx, () =>
        ctx.journal.append({ kind: 'run_handle', attemptId, runId, generation }),
      )
      if (
        attempt.dispatch_generation !== generation ||
        !['send_started', 'running'].includes(attempt.state)
      ) {
        touch(ctx, o.id)
        return
      }
    }
    sqlite
      .prepare(
        `UPDATE orc_attempts SET run_id = ?, state = CASE WHEN state = 'send_started' THEN 'running' ELSE state END, refused_streak = CASE WHEN ? = 1 THEN refused_streak ELSE 0 END, updated_at = ? WHERE id = ?`,
      )
      .run(runId, generation === null ? 0 : 1, now, attemptId)
    // A Stop (or finish of a non-requesting attempt) that raced the admission: the handle arrived late; stop it now.
    if (['stopping'].includes(o.status) || isTerminalStatus(o.status) || attempt.retired)
      sqlite
        .prepare(
          'UPDATE orc_attempts SET retired = 1, stop_requested_at = COALESCE(stop_requested_at, ?) WHERE id = ?',
        )
        .run(now, attemptId)
    if (generation === null)
      journalSoft(ctx, () => ctx.journal.append({ kind: 'run_handle', attemptId, runId }))
    touch(ctx, o.id)
  }

  private recordSendFailure(
    ctx: Ctx,
    attemptId: string,
    error: unknown,
    generation: number | null,
  ): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'send_started') return
    if (generation !== null && attempt.dispatch_generation !== generation) return
    const o = requireOrch(sqlite, attempt.orchestration_id)
    const cause = generation === null ? undefined : codingFailureCause(error)
    if (generation !== null && cause !== undefined) {
      // `startRun` threw before the run was queued, so nothing was launched: the generation is closed (or refused) by
      // its typed cause. A throw that carries no cause stays on the ordinary paths below.
      this.closeCoding(ctx, o, attempt, generation, cause)
      return
    }
    const definite =
      error instanceof HttpError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 409, 429].includes(error.status)
    if (isNotDispatched(error) && attempt.kind === 'step') {
      this.refuseDispatch(ctx, o, attempt)
      return
    }
    if (isNotDispatched(error)) {
      // Provably nothing was sent: put the work back and try again after a pause.
      sqlite
        .prepare(
          "UPDATE orc_attempts SET state = 'refused', unknown_reason = 'not_dispatched', terminated_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, attemptId)
      sqlite
        .prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ? AND state = 'pending'")
        .run(attempt.turn_id)
      if (attempt.kind === 'lead')
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
      else if (attempt.step_id) setStepStatus(sqlite, o.id, attempt.step_id, 'queued', null, now)
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attemptId)
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
    } else if (definite) {
      refuseAttempt(sqlite, attempt, error instanceof HttpError ? error.code : 'refused', now)
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attemptId)
      if (attempt.step_id) {
        setStepStatus(sqlite, o.id, attempt.step_id, 'failed', 'admission_refused', now)
        addCause(
          sqlite,
          o.id,
          'step_failed',
          attempt.step_id,
          now,
          'Hermes refused to start the step',
        )
      } else {
        sqlite
          .prepare(
            'UPDATE orchestrations SET consecutive_lead_failures = consecutive_lead_failures + 1 WHERE id = ?',
          )
          .run(o.id)
        addCause(sqlite, o.id, 'lead_failed', attempt.id, now, 'Hermes refused to start the turn')
      }
    } else {
      this.markUnknown(ctx, o, attempt, 'admission_uncertain')
      // A Stop owed to a run whose handle never arrived is kept; the attempt stays fenced until resolved.
    }
    touch(ctx, o.id)
  }

  /**
   * v8.2 / v8.3: a proven refusal of one dispatch generation of a step attempt. The refusal is journaled (fsync) in the
   * transaction that returns the attempt to `created`; if it cannot be journaled the attempt stays sent/unknown. The
   * generation is not a logical attempt. After five refusals in a row the attempt waits (ten minutes, or a readiness
   * change); at twenty over its lifetime only the person continues a workflow node, and an orchestration step fails.
   */
  private refuseDispatch(ctx: Ctx, o: OrchRow, attempt: AttemptRow): void {
    const { sqlite, now } = ctx
    try {
      ctx.journal.append({
        kind: 'send_refused',
        attemptId: attempt.id,
        orchestrationId: o.id,
        generation: attempt.dispatch_generation,
      })
    } catch (error) {
      ctx.journalFailure = error instanceof Error ? error.message : String(error)
      this.markUnknown(ctx, o, attempt, 'refusal_unjournaled')
      return
    }
    recordRefusal(sqlite, o, attempt, attempt.dispatch_generation, now)
    if (attempt.kind === 'step') this.cooldown.set(o.id, this.nowMs() + this.retryMs)
    touch(ctx, o.id)
  }

  // ---------------------------------------------------------------------------------------- coding: release and closure

  /**
   * The executor's answer at the release critical section (7.7b §6): the common admission rules, the phase guard for
   * this generation and launch, the deadline the launch was prepared with, then the policy and limit checks (part 2).
   * A pure read: it never writes and never awaits, and says no with a typed cause.
   */
  private decideRelease(sqlite: DatabaseSync, subject: ReleaseSubject): ReleaseDecision {
    const no = (cause: string): ReleaseDecision => ({ allowed: false, cause })
    const attempt = readAttempt(sqlite, subject.attemptId)
    const generation = attempt ? readGeneration(sqlite, attempt.id, subject.generation) : undefined
    const o = attempt ? readOrch(sqlite, attempt.orchestration_id) : undefined
    // The phase guard: release needs `send_started` or `running` for THIS generation, this launch, and this launch's
    // handle or none yet. Anything else means the attempt moved on without this launch.
    if (!attempt || !generation || !o || generation.launch_id !== subject.launchId)
      return no('retired')
    if (
      attempt.dispatch_generation !== subject.generation ||
      generation.closed_cause !== null ||
      !['send_started', 'running'].includes(attempt.state) ||
      (attempt.run_id !== null &&
        generation.run_id !== null &&
        attempt.run_id !== generation.run_id)
    )
      return no('retired')
    const nowMs = this.nowMs()
    const denial = admissionDenial(
      sqlite,
      this.options.fence,
      o,
      attempt,
      new Date(nowMs).toISOString(),
    )
    if (denial) return no(denial.cause)
    // The prepared expiry may not outlive the deadline as it stands now (it can move earlier while a launch is arming).
    if (o.deadline_at !== null && subject.expiry > Date.parse(o.deadline_at))
      return no('deadline_changed')
    // A coding worker: the prepared invocation is the stored policy's, every external identity is read once more (inside
    // the critical section, immediately before `releasing`), and the run's coding step limit still has room (7.7b §3, §8).
    if (attempt.kind === 'step' && attempt.runtime !== 'hermes') {
      const stored = readWorkerPolicy(sqlite, o.id, attempt.agent_id)
      if (!stored || subject.policyId !== stored.policyId) return no('agent_changed')
      // A stored policy with a permission workers may never have (a damaged or hand-edited row) never launches.
      if (isForbiddenPermission(stored.policy.permission)) return no('permission_forbidden')
      const check = this.options.codingFacts?.checkPolicy(attempt.agent_id, stored.policy)
      if (!check) return no('agent_changed')
      if (!check.ok) return no(check.cause)
      if (check.id !== stored.policyId) return no('agent_changed')
      if ((subject.executed ?? 0) >= o.coding_steps) return no('limit')
    }
    // Extra checks (tests inject causes here): the policy and the limits.
    const refused =
      this.options.releaseChecks?.policy?.(sqlite, subject) ??
      this.options.releaseChecks?.limits?.(sqlite, subject)
    return refused === undefined ? { allowed: true } : no(refused)
  }

  /** A step the person chose to wait for is looked at again when its window resets (once per reset time). */
  private readonly resetWakes = new Set<string>()
  private wakeAtReset(ctx: Ctx, orchId: string, stepId: string): void {
    const hold = holdOf(ctx.sqlite, orchId, stepId)
    if (hold?.state !== 'waiting') return
    const key = `${orchId}:${stepId}:${hold.resets_at}`
    if (this.resetWakes.has(key)) return
    this.resetWakes.add(key)
    const delay = Math.max(0, Date.parse(hold.resets_at) - Date.parse(ctx.now))
    this.wakeAfter(Math.min(delay + 50, 2_000_000_000))
  }

  /** A pump after a pause, so a held-back attempt is tried again without waiting for the next sweep. */
  private wakeAfter(ms: number): void {
    const timer = setTimeout(() => this.kick(), ms + 5)
    timer.unref()
  }

  /**
   * Closes a generation that provably launched nothing (design §6, M2). Refusal causes take 7.1's `send_refused` path
   * (counters, wait, lifetime limit); every other cause writes one `send_closed` record and moves the attempt and its
   * step as the cause table says, never touching the refusal counters.
   */
  private closeCoding(
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    generation: number,
    cause: string,
  ): void {
    const { sqlite, now } = ctx
    const klass = causeClass(cause)
    if (klass === 'refusal') {
      try {
        ctx.journal.append({
          kind: 'send_refused',
          attemptId: attempt.id,
          orchestrationId: o.id,
          generation,
        })
      } catch (error) {
        ctx.journalFailure = error instanceof Error ? error.message : String(error)
        this.markUnknown(ctx, o, attempt, 'refusal_unjournaled')
        return
      }
      sqlite
        .prepare(
          'UPDATE orc_generations SET closed_cause = COALESCE(closed_cause, ?), closed_at = COALESCE(closed_at, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(cause, now, attempt.id, generation)
      sqlite
        .prepare(
          "UPDATE message_runs SET state = 'failed' WHERE orchestration_attempt_id = ? AND generation = ? AND state = 'pending'",
        )
        .run(attempt.id, generation)
      dropUnlaunchedInput(sqlite, attempt.id, generation)
      sqlite.prepare('UPDATE orc_attempts SET run_id = NULL WHERE id = ?').run(attempt.id)
      recordRefusal(sqlite, o, attempt, generation, now)
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
      this.wakeAfter(this.retryMs)
      addHistory(sqlite, o.id, 'send_refused', { attemptId: attempt.id, generation, cause }, now)
      touch(ctx, o.id)
      return
    }
    try {
      ctx.journal.append({
        kind: 'send_closed',
        attemptId: attempt.id,
        orchestrationId: o.id,
        generation,
        cause,
      })
    } catch (error) {
      ctx.journalFailure = error instanceof Error ? error.message : String(error)
      this.markUnknown(ctx, o, attempt, 'closure_unjournaled')
      return
    }
    applyClosure(sqlite, o, attempt, generation, cause, now)
    if (klass === 'hold') {
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
      this.wakeAfter(this.retryMs)
      const fresh = requireOrch(sqlite, o.id)
      if (cause === 'budget') this.pauseFor(ctx, fresh, 'budget')
      if (cause === 'unknown_cost') this.pauseFor(ctx, fresh, 'unknown_spend')
    } else if (klass === 'terminal') bumpAdmission(sqlite)
    addHistory(sqlite, o.id, 'send_closed', { attemptId: attempt.id, generation, cause }, now)
    touch(ctx, o.id)
  }

  /**
   * What a terminal run of a coding attempt means (design §6, §7). The launch's journal state decides: a launch that
   * provably never ran closes its generation; one that may have run needs end proof before anything is accepted.
   */
  private reconcileCoding(
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    run: RunFacts & { id?: string },
  ): void {
    const { sqlite, now } = ctx
    // A frozen home writes no journal records and signals nothing (decision 71); the sweep tries again after the reset.
    if (this.options.fence.executionFrozenIn(sqlite) !== null) return
    const generation = readGeneration(sqlite, attempt.id, attempt.dispatch_generation)
    if (!generation) return void this.markUnknown(ctx, o, attempt, 'generation_missing')
    const facts = launchFacts(sqlite, ctx.journal, generation.launch_id)
    if (facts.kind === 'unreadable') return // the journal can't be read: fail closed, the fence reports it
    if (provenNoLaunch(facts)) {
      if (attempt.state !== 'running') return // an unknown attempt with no launch is settled by the person, not here
      const refusal = sqlite
        .prepare('SELECT cause FROM coding_refusals WHERE run_id = ?')
        .get(attempt.run_id!) as { cause: string } | undefined
      const cause =
        refusal?.cause ??
        (facts.kind === 'known' ? facts.revokeCause : null) ??
        // A run that Score's own restart interrupted before any launch was requested was never refused: it is a restart
        // (hold class, no readiness counters), not a failed start (F1 #6).
        (run.status === 'cancelled'
          ? 'stop'
          : run.status === 'interrupted'
            ? 'restart'
            : 'start_failed')
      return void this.closeCoding(ctx, o, attempt, attempt.dispatch_generation, cause)
    }
    // The launch may have executed. A released launch is the qualified release that resets the refusal streak (N7).
    if (facts.kind === 'known' && facts.mayHaveExecuted && attempt.refused_streak > 0)
      sqlite.prepare('UPDATE orc_attempts SET refused_streak = 0 WHERE id = ?').run(attempt.id)
    if (facts.kind !== 'known' || !facts.proof) {
      if (attempt.state === 'running') this.markUnknown(ctx, o, attempt, 'run_not_proven_ended')
      return
    }
    // Proof for an abandoned attempt is recorded and never consumed (the same path as any abandoned attempt).
    if (attempt.state === 'abandoned') {
      sqlite
        .prepare(
          'UPDATE orc_attempts SET evidence = ?, terminated_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          run.status === 'completed' ? 'completed' : 'failed',
          run.ended_at ?? now,
          now,
          attempt.id,
        )
      addHistory(sqlite, o.id, 'late_result', { attemptId: attempt.id, status: run.status }, now)
      return
    }
    const late = attempt.state !== 'running'
    const spend = this.spend(sqlite, attempt)
    const reply = sqlite
      .prepare('SELECT reply, truncated FROM coding_run_results WHERE run_id = ?')
      .get(attempt.run_id!) as { reply: string; truncated: number } | undefined
    // The retained copy in `coding_run_results` is part of the coding inventory too (F1 #7).
    if (reply) addCodingStored(sqlite, o.id, Buffer.byteLength(reply.reply))
    const status = run.status
    // A workflow node names why a coding step produced no usable answer (7.7c §3): the person reads this on the node.
    const failure =
      o.planner !== 'workflow'
        ? 'the step run failed'
        : REPLY_TOO_LARGE_PATTERN.test(`${run.error ?? ''}`)
          ? 'answer too long to read a verdict'
          : status === 'completed' && !reply
            ? 'no final answer'
            : 'the step run failed'
    const disposition: 'completed' | 'failed' | 'cancelled' =
      status === 'cancelled'
        ? 'cancelled'
        : status === 'completed' && reply
          ? 'completed'
          : 'failed'
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'terminated', evidence = ?, terminated_at = ?, unknown_reason = NULL,
           spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END,
           result_text = ?, result_truncated = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        disposition === 'cancelled' ? null : disposition,
        run.ended_at ?? now,
        spend.usd,
        spend.complete ? 1 : 0,
        spend.complete ? 1 : 0,
        spend.complete ? 1 : 0,
        // The result belongs to the attempt only if it is accepted now, never from a late proof.
        !late && disposition === 'completed' ? reply!.reply : null,
        !late && disposition === 'completed' && reply!.truncated === 1 ? 1 : 0,
        now,
        attempt.id,
      )
    bumpAdmission(sqlite)
    const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
    if (!step) return
    if (late || step.retired) {
      // Late proof closes the obligations and settles the accounting; its result is permanently non-consumable (§7).
      addHistory(
        sqlite,
        o.id,
        'late_result',
        { attemptId: attempt.id, stepId: step.id, status: disposition },
        now,
      )
      if (late && !step.retired && ['unknown', 'admitted'].includes(step.status)) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'failed',
          'ended after it was last seen: its result is not used',
          now,
        )
        addCause(sqlite, o.id, 'step_failed', step.id, now, 'ended after it was last seen')
      }
      return
    }
    if (disposition === 'cancelled') {
      // Obligations closed, no result, never retried.
      setStepStatus(sqlite, o.id, step.id, 'cancelled', 'stop', now)
      addCause(sqlite, o.id, 'step_cancelled', step.id, now, 'stopped')
      return
    }
    const text =
      disposition === 'completed'
        ? reply!.truncated === 1
          ? `${reply!.reply}\n[…cut at ${CODING_RESULT_BYTES / 1024} KiB by Score]`
          : reply!.reply
        : [run.output, run.error ? `[error] ${run.error}` : null].filter(Boolean).join('\n')
    const result = redactBounded(text, CODING_RESULT_BYTES + 128)
    sqlite
      .prepare(
        `UPDATE orc_steps SET status = ?, disposition = ?, result = ?, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?`,
      )
      .run(
        disposition === 'completed' ? 'succeeded' : 'failed',
        disposition === 'failed' ? failure : null,
        result,
        now,
        o.id,
        step.id,
      )
    addCodingStored(
      sqlite,
      o.id,
      Buffer.byteLength(result) * 2 + Buffer.byteLength(run.output ?? ''),
    )
    this.stepEnded(ctx, o, step, disposition === 'completed', result, attempt.id)
  }

  // ------------------------------------------------------------------------------------------------ observation

  /** What the observed runs say about attempts: termination evidence, late evidence, spend. Pure read. */
  private plan(
    sqlite: DatabaseSync,
  ): { attempt: AttemptRow; run: RunFacts; spend: ReturnType<SpendReader> }[] {
    const rows = z
      .array(AttemptRowSchema)
      .parse(
        sqlite
          .prepare(
            `SELECT * FROM orc_attempts WHERE run_id IS NOT NULL AND unknown_reason IS NOT 'history_reset' AND (state IN ('running', 'unknown') OR (state = 'abandoned' AND evidence IS NULL) OR (state = 'terminated' AND settled = 0))`,
          )
          .all(),
      )
    const work: { attempt: AttemptRow; run: RunFacts; spend: ReturnType<SpendReader> }[] = []
    for (const attempt of rows) {
      const run = sqlite
        .prepare('SELECT status, output, error, ended_at, terminal_source FROM runs WHERE id = ?')
        .get(attempt.run_id!) as RunFacts | undefined
      if (!run) continue
      const spend = this.spend(sqlite, attempt)
      const terminalRun = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      const evidence = isEvidence(run)
      const ends = isCodingStep(attempt)
        ? terminalRun &&
          (attempt.state === 'running' ||
            (['unknown', 'abandoned'].includes(attempt.state) && codingProofIn(sqlite, attempt)))
        : terminalRun &&
          ((attempt.state === 'running' && true) ||
            (attempt.state === 'unknown' && evidence) ||
            (attempt.state === 'abandoned' && evidence))
      const settle = attempt.state === 'terminated' && spend.complete
      const spendChanged =
        (spend.usd !== null && spend.usd !== attempt.spend_usd) ||
        spend.complete !== attempt.spend_complete ||
        settle !== attempt.settled
      if (ends || spendChanged) work.push({ attempt, run, spend })
    }
    return work
  }

  /** Reads the runs of live attempts and records termination evidence, results and spend. Returns whether anything changed. */
  private async reconcile(): Promise<boolean> {
    if (this.db.read((sqlite) => this.plan(sqlite)).length === 0) return false
    return this.mutate((ctx) => this.reconcileAttempts(ctx))
  }

  private reconcileAttempts(ctx: Ctx): boolean {
    const { sqlite, now } = ctx
    let changed = false
    for (const { attempt, run, spend } of this.plan(sqlite)) {
      const o = readOrch(sqlite, attempt.orchestration_id)
      if (!o) continue
      changed = true
      touch(ctx, o.id)
      const evidence = isEvidence(run)
      const terminalRun =
        evidence ||
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'interrupted'
      if (isCodingStep(attempt)) {
        // A coding run's end is decided by its launch's journal state and proof, never by the run's own terminal word.
        const codingEnded =
          terminalRun &&
          (attempt.state === 'running' ||
            (['unknown', 'abandoned'].includes(attempt.state) && codingProofIn(sqlite, attempt)))
        if (codingEnded) this.reconcileCoding(ctx, o, attempt, run)
        else {
          const settle = attempt.state === 'terminated' && spend.complete
          sqlite
            .prepare(
              'UPDATE orc_attempts SET spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?',
            )
            .run(spend.usd, spend.complete ? 1 : 0, settle ? 1 : 0, settle ? 1 : 0, now, attempt.id)
        }
        continue
      }
      const ending =
        terminalRun &&
        (attempt.state === 'running' ||
          (evidence && (attempt.state === 'unknown' || attempt.state === 'abandoned')))
      if (!ending) {
        const settle = attempt.state === 'terminated' && spend.complete
        sqlite
          .prepare(
            'UPDATE orc_attempts SET spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?',
          )
          .run(spend.usd, spend.complete ? 1 : 0, settle ? 1 : 0, settle ? 1 : 0, now, attempt.id)
        continue
      }
      // Late evidence for an abandoned attempt is recorded and never consumed.
      if (attempt.state === 'abandoned') {
        sqlite
          .prepare(
            'UPDATE orc_attempts SET evidence = ?, terminated_at = ?, updated_at = ? WHERE id = ?',
          )
          .run(run.status, run.ended_at ?? now, now, attempt.id)
        addHistory(sqlite, o.id, 'late_result', { attemptId: attempt.id, status: run.status }, now)
        continue
      }
      if (evidence) this.accept(ctx, o, attempt, run.status as 'completed' | 'failed', run)
      // `cancelled` / `interrupted` do not prove the agent loop ended (7.1 v6): the attempt is unknown, not terminated.
      else if (run.terminal_source === 'recovered') {
        // The text is shown to the person (chat is unchanged) but proves nothing about the agent loop: obligations stay.
        addHistory(
          sqlite,
          o.id,
          'recovered_text',
          {
            attemptId: attempt.id,
            status: run.status,
            text: run.output ? redactBounded(run.output, 500) : null,
          },
          now,
        )
        this.markUnknown(ctx, o, attempt, 'recovered_text_only')
      } else this.markUnknown(ctx, o, attempt, `run_${run.status}`)
    }
    return changed
  }

  /** Termination evidence arrived: the attempt is terminated, and its output is accepted as the step result. */
  private accept(
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    evidence: 'completed' | 'failed',
    run: { output: string | null; error: string | null; ended_at: string | null },
  ): void {
    const { sqlite, now } = ctx
    const spend = this.spend(sqlite, attempt)
    const settled = spend.complete
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'terminated', evidence = ?, terminated_at = ?, unknown_reason = NULL,
           spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?`,
      )
      .run(
        evidence,
        run.ended_at ?? now,
        spend.usd,
        spend.complete ? 1 : 0,
        settled ? 1 : 0,
        settled ? 1 : 0,
        now,
        attempt.id,
      )
    sqlite
      .prepare(
        'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
      )
      .run(now, attempt.id)
    bumpAdmission(sqlite)
    if (attempt.kind === 'lead') {
      if (evidence === 'failed') {
        sqlite
          .prepare(
            'UPDATE orchestrations SET consecutive_lead_failures = consecutive_lead_failures + 1 WHERE id = ?',
          )
          .run(o.id)
        addCause(
          sqlite,
          o.id,
          'lead_failed',
          attempt.id,
          now,
          run.error ? redactBounded(run.error, 300) : 'the turn failed',
        )
      } else
        sqlite
          .prepare('UPDATE orchestrations SET consecutive_lead_failures = 0 WHERE id = ?')
          .run(o.id)
      return
    }
    const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
    if (!step) return
    // A step the lead cancelled keeps its cancelled status; whatever it produced is recorded, not consumed.
    if (step.retired) {
      addHistory(
        sqlite,
        o.id,
        'late_result',
        { attemptId: attempt.id, stepId: step.id, status: evidence },
        now,
      )
      return
    }
    const message = sqlite
      .prepare('SELECT parts FROM messages WHERE id = ?')
      .get(attempt.message_id) as { parts: string } | undefined
    const messageText = message
      ? (JSON.parse(message.parts) as { kind: string; text?: string }[])
          .filter((part) => part.kind === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
      : ''
    // A workflow step keeps up to 32 KiB, taken from the complete-reply facts recorded when the run ended (the run record
    // itself is cut at 8 KiB); orchestration steps keep 8 KiB.
    const workflow = o.planner === 'workflow'
    const facts = workflow ? readResult(sqlite, attempt.id) : undefined
    const body = facts?.output ?? run.output ?? (messageText || '')
    const limit = workflow ? WORKFLOW_LIMITS.outputBytes : ORCH_LIMITS.resultBytes
    const result = redactBounded(
      evidence === 'failed' && run.error ? `${body}\n[error] ${run.error}`.trim() : body,
      limit,
    )
    sqlite
      .prepare(
        `UPDATE orc_steps SET status = ?, disposition = ?, result = ?, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?`,
      )
      .run(
        evidence === 'completed' ? 'succeeded' : 'failed',
        evidence === 'failed' ? 'the step run failed' : null,
        result,
        now,
        o.id,
        step.id,
      )
    // Every retained copy is charged (v8.1 item 5): the stored result, the streamed reply row and the run record.
    // Accepting a result never fails on quota: the protected reserve exists for exactly this.
    addStored(
      sqlite,
      o.id,
      Buffer.byteLength(result) +
        Buffer.byteLength(messageText) +
        Buffer.byteLength(run.output ?? ''),
    )
    this.stepEnded(ctx, o, step, evidence === 'completed', result, attempt.id)
  }

  // ---------------------------------------------------------------------------------------------------- stops

  /**
   * A step's result was accepted: the lead is told (an advisor consult as advice, 3.14), a check set to run after each
   * step is queued (3.13), and a failure like an earlier one is taken to the advisor.
   */
  private stepEnded(
    ctx: Ctx,
    o: OrchRow,
    step: StepRow,
    ok: boolean,
    result: string,
    attemptId: string,
  ): void {
    if (isAdvisorStep(step)) return adviceArrived(ctx, o, step, ok)
    // 3.15–3.16: a vote answer reaches the lead only through the tally, a scan part only with the whole scan
    // (settleHelpers); a helper's read-only work leaves nothing for the check to test.
    if (step.role === 'vote' || step.helper_role?.startsWith('scan_')) return
    addCause(ctx.sqlite, o.id, ok ? 'step_succeeded' : 'step_failed', step.id, ctx.now)
    if (ok && step.role !== 'helper') queueCheckAfterStep(ctx, o.id)
    else if (!ok)
      adviseOnRepeatFailure(ctx, o, { ...step, status: 'failed', result }, result, attemptId)
  }

  // --------------------------------------------------------------------------------------------------- checks (3.13)

  /**
   * Starts queued check runs (one at a time per job, only while it runs), stops the ones whose job no longer runs, and
   * cancels queued ones of jobs that ended. A run's end is recorded by itself (its own transaction) and wakes the lead.
   */
  private async serviceChecks(): Promise<boolean> {
    for (const [id, job] of this.checkJobs) {
      const status = this.db.read((sqlite) => readOrch(sqlite, job.orchId)?.status)
      if (status === undefined || !['running', 'paused'].includes(status)) {
        job.proc.stop()
        this.checkJobs.delete(id)
      }
    }
    const starts = await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      const rows = sqlite
        .prepare(
          `SELECT c.id, c.orchestration_id, o.status FROM orc_checks c JOIN orchestrations o ON o.id = c.orchestration_id
           WHERE c.outcome = 'queued' ORDER BY c.queued_at, c.rowid`,
        )
        .all() as { id: string; orchestration_id: string; status: string }[]
      const started: { id: string; orchId: string; config: CheckConfig }[] = []
      // A run marked running that nothing is carrying (its recording failed) would hold the job forever: end it.
      for (const stuck of sqlite
        .prepare("SELECT id, orchestration_id FROM orc_checks WHERE outcome = 'running'")
        .all() as { id: string; orchestration_id: string }[]) {
        if (this.checksInFlight.has(stuck.id)) continue
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'interrupted', ended_at = ? WHERE id = ?")
          .run(now, stuck.id)
        addCause(
          sqlite,
          stuck.orchestration_id,
          'check_interrupted',
          stuck.id,
          now,
          'its result was lost',
        )
        touch(ctx, stuck.orchestration_id)
      }
      for (const row of rows) {
        if (!['running', 'paused'].includes(row.status)) {
          sqlite
            .prepare("UPDATE orc_checks SET outcome = 'cancelled', ended_at = ? WHERE id = ?")
            .run(now, row.id)
          touch(ctx, row.orchestration_id)
          continue
        }
        // A paused job's checks wait; and one run at a time per job.
        if (row.status !== 'running' || isFenced(sqlite)) continue
        const busy = sqlite
          .prepare("SELECT 1 FROM orc_checks WHERE orchestration_id = ? AND outcome = 'running'")
          .get(row.orchestration_id)
        if (busy || started.some((s) => s.orchId === row.orchestration_id)) continue
        const config = checkConfigOf(sqlite, row.orchestration_id)
        if (config === null) {
          sqlite
            .prepare("UPDATE orc_checks SET outcome = 'cancelled', ended_at = ? WHERE id = ?")
            .run(now, row.id)
          continue
        }
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'running', started_at = ? WHERE id = ?")
          .run(now, row.id)
        addHistory(sqlite, row.orchestration_id, 'check_started', { checkId: row.id }, now)
        touch(ctx, row.orchestration_id)
        started.push({ id: row.id, orchId: row.orchestration_id, config })
        this.checksInFlight.add(row.id)
      }
      return started
    })
    for (const start of starts) void this.runCheckProcess(start)
    return false
  }

  private async runCheckProcess(start: {
    id: string
    orchId: string
    config: CheckConfig
  }): Promise<void> {
    const record = async (
      outcome: 'passed' | 'failed' | 'timed_out' | 'refused' | 'cancelled',
      exitCode: number | null,
      output: string,
    ) => {
      // Redacted before it is cut, so a secret straddling the cut is still recognised (review P3).
      const kept = tailBytes(redact(output), CHECK_OUTPUT_BYTES)
      await this.mutate((ctx) => {
        const { sqlite, now } = ctx
        const row = sqlite.prepare('SELECT outcome FROM orc_checks WHERE id = ?').get(start.id) as
          { outcome: string } | undefined
        if (row?.outcome !== 'running') return
        sqlite
          .prepare(
            'UPDATE orc_checks SET outcome = ?, exit_code = ?, ended_at = ?, output = ? WHERE id = ?',
          )
          .run(outcome, exitCode, now, kept, start.id)
        addStored(sqlite, start.orchId, Buffer.byteLength(kept))
        addHistory(
          sqlite,
          start.orchId,
          'check_ended',
          { checkId: start.id, outcome, exitCode },
          now,
        )
        // Only Score's own words here: the command's output reaches the lead quoted, never as an unquoted cause line.
        const detail =
          outcome === 'passed'
            ? 'exit 0'
            : outcome === 'timed_out'
              ? 'timed out'
              : outcome === 'refused'
                ? 'could not run'
                : outcome === 'cancelled'
                  ? 'stopped'
                  : `exit ${exitCode ?? '?'}`
        addCause(
          sqlite,
          start.orchId,
          outcome === 'passed' ? 'check_passed' : 'check_failed',
          start.id,
          now,
          detail,
        )
        // 3.14: the same check failure twice in a row goes to the advisor.
        const o = readOrch(sqlite, start.orchId)
        if (o && outcome !== 'passed') adviseOnRepeatCheckFailure(ctx, o)
        touch(ctx, start.orchId)
      })
      this.kick()
    }
    try {
      if (!this.options.checks) return await record('refused', null, 'Checks can’t run here.')
      const proc = await this.options.checks({
        argv: start.config.argv,
        cwd: start.config.workspace,
        timeoutMs: start.config.timeoutSec * 1000,
        keepBytes: CHECK_OUTPUT_BYTES,
      })
      if ('refused' in proc) return await record('refused', null, proc.refused)
      this.checkJobs.set(start.id, { orchId: start.orchId, proc })
      const result = await proc.done
      this.checkJobs.delete(start.id)
      if (this.closed) return // recorded as interrupted at the next start
      await record(
        result.timedOut
          ? 'timed_out'
          : result.stopped
            ? 'cancelled'
            : result.exitCode === 0
              ? 'passed'
              : 'failed',
        result.exitCode,
        result.output,
      )
    } catch (error) {
      this.err(error)
      this.checkJobs.delete(start.id)
    } finally {
      // Not recorded by now (a failed write): the next pass ends it as interrupted rather than leaving it running.
      this.checksInFlight.delete(start.id)
      this.kick()
    }
  }

  /** What the lead reads about the check: the command, and the last run's verdict and output tail. */
  private leadCheck(sqlite: DatabaseSync, orchId: string) {
    const config = checkConfigOf(sqlite, orchId)
    if (config === null) return null
    const latest = checksOf(sqlite, orchId, 5).find(
      (row) => !['queued', 'cancelled'].includes(row.outcome),
    )
    return {
      argv: config.argv,
      workspace: config.workspace,
      when: config.when,
      waived:
        (
          sqlite.prepare('SELECT check_waived_at FROM orchestrations WHERE id = ?').get(orchId) as {
            check_waived_at: string | null
          }
        ).check_waived_at !== null,
      pending: checkPending(sqlite, orchId),
      latest: latest
        ? {
            outcome: latest.outcome,
            exitCode: latest.exit_code,
            current: latest.outcome === 'passed' && checkIsCurrent(sqlite, orchId, latest),
            output: tailBytes(latest.output, CHECK_LEAD_BYTES),
          }
        : null,
    }
  }

  /** Delivers owed Stops until Hermes acknowledges. Abandoned attempts keep theirs. */
  private async serviceStops(): Promise<boolean> {
    // Frozen: whose runs these handles name can't be told, so a Hermes Stop is not delivered (decision 71). A coding run
    // this process launched and is connected to is provably its own, and a Stop only ends work (decision 74): the coding
    // runtime answers those and refuses (`execution_frozen`) a recovered or inherited run, which then waits for the reset.
    const frozen = this.options.fence.executionFrozen() !== null
    const owedAll = this.db.read((sqlite) =>
      z
        .array(AttemptRowSchema)
        .parse(
          sqlite
            .prepare(
              `SELECT * FROM orc_attempts WHERE stop_requested_at IS NOT NULL AND stop_acknowledged_at IS NULL AND run_id IS NOT NULL AND state IN ('send_started', 'running', 'unknown', 'abandoned') AND unknown_reason IS NOT 'history_reset'`,
            )
            .all(),
        ),
    )
    const owed = frozen ? owedAll.filter((attempt) => attempt.runtime !== 'hermes') : owedAll
    for (const attempt of owed) {
      if (this.closed || this.stopJobs.has(attempt.id)) continue
      const last = this.stopTried.get(attempt.id)
      if (last !== undefined && this.nowMs() < last.at + last.delay) continue
      const job = this.deliverStop(attempt, frozen)
        .catch((error: unknown) => {
          this.err(error)
          return false
        })
        .then((acknowledged) => {
          this.stopJobs.delete(attempt.id)
          // An acknowledgement frees the attempt's slot, so the executor looks again; a retry wakes itself at its time.
          if (acknowledged) this.kick()
        })
      this.stopJobs.set(attempt.id, job)
    }
    // Nothing here is awaited: a slow or hung Stop never holds the pump (design §9). A finished job kicks it again.
    return false
  }

  /** One tracked Stop delivery for one attempt. Retries are paced by an exponential back-off per attempt. */
  private async deliverStop(attempt: AttemptRow, frozen: boolean): Promise<boolean> {
    const fails = this.stopTried.get(attempt.id)?.fails ?? 0
    const retry = () => {
      const delay = Math.min(this.retryMs * 2 ** fails, this.retryMs * 12)
      this.stopTried.set(attempt.id, { at: this.nowMs(), delay, fails: fails + 1 })
      this.wakeAfter(delay)
      return false
    }
    try {
      const outcome = await this.options.port.stopRun({
        agentId: attempt.agent_id,
        runId: attempt.run_id!,
      })
      // A coding Stop is acknowledged only by `stopped` or `not_running`; Hermes keeps `void` = acknowledged.
      const acknowledged =
        attempt.runtime === 'hermes'
          ? outcome !== 'unconfirmed'
          : outcome === 'stopped' || outcome === 'not_running'
      if (!acknowledged) return retry()
    } catch (error) {
      if (!(frozen && error instanceof HttpError && error.code === 'execution_frozen'))
        this.err(error)
      return retry()
    }
    // After the shutdown window the Stop stays durably owed; a late answer is not recorded into a closing database.
    if (this.abandonStops) return false
    this.stopTried.delete(attempt.id)
    await this.mutate((ctx) => {
      ctx.sqlite
        .prepare('UPDATE orc_attempts SET stop_acknowledged_at = ?, updated_at = ? WHERE id = ?')
        .run(ctx.now, ctx.now, attempt.id)
      touch(ctx, attempt.orchestration_id)
    })
    return true
  }

  // ------------------------------------------------------------------------------------------------- maintenance

  /** Daily: compacts reconciled journal entries and prunes finished, released runs older than the retention. */
  maintenance(): { journal: { kept: number; dropped: number }; pruned: number } {
    const journal = this.options.fence.journal
    const sqlite = this.db.sqlite
    const holdKey = (e: { target: string; agentId?: string | undefined }) =>
      e.target === 'team' ? 'h:team' : `h:agent:${e.agentId}`
    const newest = new Map<string, number>()
    const own = journal.readOwn()
    if (own.ok)
      for (const entry of own.entries) {
        if (entry.kind === 'authorization') newest.set(`a:${entry.orchestrationId}`, entry.n)
        if (entry.kind === 'hold') newest.set(holdKey(entry), entry.n)
        if (entry.kind === 'remap')
          newest.set(`m:${entry.orchestrationId}:${entry.agentId}`, entry.n)
        if (entry.kind === 'renewal')
          newest.set(`r:${entry.orchestrationId}:${entry.nodeId}`, entry.n)
      }
    const compacted = journal.compact((entry) => {
      if (
        entry.kind === 'send_refused' ||
        entry.kind === 'send_closed' ||
        entry.kind === 'witness'
      ) {
        const attempt = readAttempt(sqlite, entry.attemptId)
        return (
          attempt !== undefined && (attempt.state === 'terminated' || attempt.state === 'refused')
        )
      }
      if (
        entry.kind === 'send_started' ||
        entry.kind === 'run_handle' ||
        entry.kind === 'reconciled'
      ) {
        const attempt = readAttempt(sqlite, entry.attemptId)
        return (
          attempt !== undefined && (attempt.state === 'terminated' || attempt.state === 'refused')
        )
      }
      if (entry.kind === 'transition') {
        const o = readOrch(sqlite, entry.orchestrationId)
        return (
          o !== undefined &&
          isTerminalStatus(o.status) &&
          attemptsOf(sqlite, o.id).every((x) => x.state === 'terminated' || x.state === 'refused')
        )
      }
      if (entry.kind === 'remap')
        return newest.get(`m:${entry.orchestrationId}:${entry.agentId}`) !== entry.n
      // Only the newest renewal per node is needed: it carries the count, and its successor is the node's attempt.
      if (entry.kind === 'renewal')
        return newest.get(`r:${entry.orchestrationId}:${entry.nodeId}`) !== entry.n
      if (entry.kind === 'authorization' || entry.kind === 'hold') {
        // Only the newest word per run / per target is needed; the older ones are superseded.
        return (
          newest.get(entry.kind === 'hold' ? holdKey(entry) : `a:${entry.orchestrationId}`) !==
          entry.n
        )
      }
      if (entry.kind === 'stop_fence') {
        // Only fully reconciled work lets a fence go: every attempt it covers is terminated (evidence) or never sent.
        const done = (a: AttemptRow) => a.state === 'terminated' || a.state === 'refused'
        if (entry.attemptId !== undefined) {
          const attempt = readAttempt(sqlite, entry.attemptId)
          return attempt !== undefined && done(attempt)
        }
        const o = readOrch(sqlite, entry.orchestrationId)
        if (!o || !isTerminalStatus(o.status)) return false
        return attemptsOf(sqlite, o.id).every(done)
      }
      return false
    })
    const cutoff = new Date(this.nowMs() - RETENTION_MS).toISOString()
    let pruned = 0
    // Each run is pruned in its own transaction: one that cannot be pruned never holds the others (or the quota) back.
    for (const candidate of this.db.read((sqlite) => listOrchs(sqlite))) {
      if (
        !isTerminalStatus(candidate.status) ||
        (candidate.ended_at ?? candidate.updated_at) >= cutoff
      )
        continue
      try {
        const done = this.db.tx((tx) => {
          const o = readOrch(tx, candidate.id)
          if (!o) return false
          if (attemptsOf(tx, o.id).some((x) => x.state !== 'terminated' && x.state !== 'refused'))
            return false
          if (
            attemptsOf(tx, o.id).some(
              (a) =>
                a.state === 'unknown' ||
                (a.stop_requested_at !== null && a.stop_acknowledged_at === null),
            )
          )
            return false
          pruneOrchestrationRows(tx, o, new Date(this.nowMs()).toISOString())
          return true
        })
        if (done) pruned++
      } catch (error) {
        this.err(error)
      }
    }
    return { journal: compacted, pruned }
  }
}

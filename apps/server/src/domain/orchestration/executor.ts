import {
  type AgentSummary,
  WORKFLOW_LIMITS,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_CAPACITY,
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
  type RemapDecision,
  type WaiverDecision,
  type WorkflowPreflight,
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
import { redactBounded } from '../../redact.ts'
import { agentAdmits, agentPausedAt, lifecycleOf } from '../agent-lifecycle.ts'
import { briefTitle, createBrief, emitBriefChange } from '../briefs.ts'
import { insertRoom, storeMessage } from '../rooms.ts'
import { teamPausedAt } from '../team-pause.ts'
import { budgetView, canReserve, makeSpendReader, overBudget, type SpendReader } from './budget.ts'
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
  grantWaiver,
  remapAgent,
  pauseRun,
  resumeRun,
  setLimits,
  stopRun,
} from './decisions.ts'
import { applyJournalEvidence, fenceView, isFenced, type GlobalFenceStore } from './fence.ts'
import { journalDispatches } from './journal.ts'
import {
  activeStepCounts,
  addStored,
  bumpAdmission,
  cascadeBlocked,
  recordRefusal,
  compactControlHistory,
  refuseAttempt,
  reserveFor,
  setStepStatus,
} from './ops.ts'
import { renderLeadInput, renderStepInput } from './render.ts'
import { finalizeGraph, planWorkflow } from '../workflows/planner.ts'
import { workflowDetailOf, workflowEventsOf, workflowSummaryOf } from '../workflows/views.ts'
import { readVersion } from '../workflows/definitions.ts'
import { validateDefinition } from '../workflows/definition.ts'
import {
  agentIdsOf,
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

/** Only Hermes' own terminal word is evidence; a status rebuilt from session-history text is not (fix-h item 1). */
const isEvidence = (run: RunFacts): boolean =>
  (run.status === 'completed' || run.status === 'failed') && run.terminal_source !== 'recovered'

export const ORCHESTRATION_QUOTA_BYTES = 200 * 1024 * 1024
const SWEEP_MS = 10_000
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
}

type ToolResult =
  { kind: 'receipt'; receipt: OrchReceipt } | { kind: 'unauthorized'; message: string }

/**
 * The orchestration executor: the single admission authority for lead attempts and steps (design v3). All writes go
 * through `mutate`, one ingest transaction each, so events, revisions and the database stay consistent.
 */
/** Whether the step's latest attempt ended on recovered session text and was never confirmed ended. */
function recoveredOnly(attempts: AttemptRow[], stepId: string): boolean {
  const last = attempts
    .filter((a) => a.step_id === stepId)
    .reduce<AttemptRow | undefined>((best, a) => (!best || a.n > best.n ? a : best), undefined)
  return (
    last !== undefined &&
    last.unknown_reason === 'recovered_text_only' &&
    ['unknown', 'abandoned'].includes(last.state)
  )
}

/** The result revisions a step's input was built from (recorded at claim); undefined for an attempt claimed before. */
function frozenRevisions(
  sqlite: DatabaseSync,
  attemptId: string,
): Record<string, number> | undefined {
  const row = sqlite
    .prepare(
      "SELECT detail FROM orc_history WHERE kind = 'step_input_frozen' AND json_extract(detail, '$.attemptId') = ? ORDER BY id DESC LIMIT 1",
    )
    .get(attemptId) as { detail: string } | undefined
  if (!row) return undefined
  return (JSON.parse(row.detail) as { revisions?: Record<string, number> }).revisions
}

/**
 * Why an unsent step attempt's input is no longer usable (fix-j 2): a result it consumed is not a current success, only
 * ever ended on recovered text, or is at another revision than the one frozen into the input.
 */
function inputWithdrawn(
  sqlite: DatabaseSync,
  orchId: string,
  attempt: AttemptRow,
): string | undefined {
  if (attempt.kind !== 'step' || !attempt.step_id) return undefined
  const step = readStep(sqlite, orchId, attempt.step_id)
  if (!step) return undefined
  const steps = stepsOf(sqlite, orchId)
  const attempts = attemptsOf(sqlite, orchId)
  // A workflow step has no `after`: what it consumed is recorded in `wf_consumed` and judged here at send (fix J, 7.1).
  const consumed = sqlite
    .prepare(
      'SELECT producer, producer_step, output_revision, kind, withdrawn FROM wf_consumed WHERE orchestration_id = ? AND step_id = ?',
    )
    .all(orchId, step.id) as {
    producer: string
    producer_step: string
    output_revision: number
    kind: string
    withdrawn: number
  }[]
  for (const c of consumed) {
    if (c.withdrawn === 1) return `${c.producer}'s result was withdrawn`
    if (c.kind === 'default') continue
    const producer = sqlite
      .prepare(
        'SELECT state, output_revision FROM wf_nodes WHERE orchestration_id = ? AND node_id = ?',
      )
      .get(orchId, c.producer) as { state: string; output_revision: number } | undefined
    if (!producer || !['succeeded', 'failed'].includes(producer.state))
      return `${c.producer} is no longer a resolved result`
    if (producer.output_revision !== c.output_revision)
      return `${c.producer} changed after this step's input was built`
    const producerStep = steps.find((s) => s.id === c.producer_step)
    if (producerStep && c.kind === 'output' && recoveredOnly(attempts, producerStep.id))
      return `${c.producer} only ended on recovered text`
  }
  const frozen = frozenRevisions(sqlite, attempt.id)
  for (const dep of step.after_steps) {
    const current = steps.find((s) => s.id === dep)
    if (!current || current.status !== 'succeeded' || current.result === null)
      return `${dep} is no longer a successful result`
    if (recoveredOnly(attempts, dep)) return `${dep} only ended on recovered text`
    if (frozen && frozen[dep] !== undefined && frozen[dep] !== current.result_revision)
      return `${dep} changed after this step's input was built`
  }
  return undefined
}

/** A lead-planned run; a workflow run id answers 404 here (its routes are /api/workflow-runs). */
function requireLeadOrch(sqlite: DatabaseSync, id: string): OrchRow {
  const o = requireOrch(sqlite, id)
  if (o.planner !== 'lead') throw new HttpError(404, 'not_found', 'Unknown orchestration')
  return o
}

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
  private readonly stopTried = new Map<string, number>()
  private readonly fingerprints = new Map<string, string>()
  private readonly ownershipSeen = new Map<string, string>()
  private readonly served = new Map<string, boolean>()

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
      const jobs = await this.mutate((ctx) => this.admit(ctx))
      for (const id of jobs) progressed = (await this.dispatch(id)) || progressed
      progressed = (await this.serviceStops()) || progressed
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
              data: workflowSummaryOf(sqlite, fresh, this.options.fence.journal),
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
    agents?: Pick<AgentSummary, 'id' | 'served'>[],
  ): Promise<Preflight> {
    const { port, access } = this.options
    const fake = port.mode === 'fake'
    const checks: PreflightCheck[] = []
    const add = (id: PreflightCheck['id'], status: PreflightCheck['status'], message: string) =>
      checks.push({ id, status, message })
    const known = new Map((agents ?? (await port.listAgents())).map((agent) => [agent.id, agent]))
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
        : `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running`,
    )
    const reserve = reserveFor(12, 20)
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
    const listed = leadProblem
      ? null
      : ((await port.mcpTools?.(leadAgentId).catch(() => null)) ?? null)
    if (listed) {
      const missing = required.filter((name) => !listed.includes(name))
      add(
        'tool_readiness',
        missing.length ? 'fail' : 'ok',
        missing.length
          ? `The lead's Hermes does not list ${missing.join(', ')}. Reload MCP (/reload-mcp in that profile, or restart its gateway), then try again.`
          : 'The lead sees every orch.* tool',
      )
    } else
      add(
        'tool_readiness',
        fake ? 'ok' : 'unknown',
        fake
          ? 'Scripted lead'
          : 'Score cannot see which MCP tools the lead has. Hermes caches the tool list per connection, so after Score is upgraded reload MCP (/reload-mcp, or restart the gateway) before starting.',
      )
    return {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
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
      },
      reserveBytes: reserve,
    }
  }

  /** Orchestrations that hold capacity: running ones, and finished ones whose attempts are still not confirmed ended. */
  private capacityUsed(sqlite: DatabaseSync): number {
    return listOrchs(sqlite).filter(
      (o) =>
        !isTerminalStatus(o.status) ||
        attemptsOf(sqlite, o.id).some((a) => a.state === 'unknown' && a.abandoned_at === null),
    ).length
  }

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
    agents?: Pick<AgentSummary, 'id' | 'served'>[],
  ): Promise<OrchestrationCreated> {
    const preflight = await this.preflight(body.leadAgentId, body.allowedAgents, agents)
    if (new Set(body.allowedAgents).size !== body.allowedAgents.length)
      throw new HttpError(400, 'bad_request', 'allowedAgents lists an agent twice')
    if (!preflight.ok) {
      const failed = (id: string) =>
        preflight.checks.some((check) => check.id === id && check.status === 'fail')
      const details = { checks: preflight.checks }
      if (failed('global_fence')) throw new HttpError(409, 'fenced', 'Admission is fenced', details)
      if (failed('capacity'))
        throw new HttpError(429, 'capacity', 'Too many orchestrations are running', details)
      if (failed('quota'))
        throw new HttpError(
          409,
          'quota_exhausted',
          'There is not enough orchestration storage left',
          details,
        )
      throw new HttpError(409, 'preflight_failed', 'The preflight failed', details)
    }
    const id = `orc-${randomUUID().slice(0, 8)}`
    await this.mutate((ctx) => this.insert(ctx, id, body, preflight))
    this.kick()
    return { orchestration: this.summary(id), preflight }
  }

  private insert(ctx: Ctx, id: string, body: OrchestrationCreate, preflight: Preflight): void {
    const { sqlite, now } = ctx
    if (isFenced(sqlite)) throw new HttpError(409, 'fenced', 'Admission is fenced')
    const live = this.capacityUsed(sqlite)
    if (live >= ORCH_CAPACITY.runningOrchestrations)
      throw new HttpError(
        429,
        'capacity',
        `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running`,
      )
    const reserve = reserveFor(body.maxSteps, body.maxLeadTurns)
    if (this.quotaUsed(sqlite) + reserve > this.quotaBytes)
      throw new HttpError(
        409,
        'quota_exhausted',
        'There is not enough orchestration storage left for this run',
      )
    if (body.deadlineAt !== undefined && body.deadlineAt <= now)
      throw new HttpError(400, 'bad_request', 'The deadline must be in the future')
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
           status, acknowledgement, preflight, reserve_bytes, stored_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
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
      )
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
    addCause(sqlite, id, 'started', null, now)
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
    return this.decide(id, (ctx) => setLimits(ctx, id, body))
  }
  pause(id: string, body: RunControl) {
    return this.decide(id, (ctx) => pauseRun(ctx, id, body))
  }
  resume(id: string, body: RunControl) {
    return this.decide(id, (ctx) => resumeRun(ctx, id, body))
  }
  /** Stop ignores a stale page: it can only reduce risk. */
  stop(id: string) {
    return this.decide(id, (ctx) => stopRun(ctx, id))
  }
  remap(id: string, body: RemapDecision) {
    return this.decide(id, (ctx) => remapAgent(ctx, id, body))
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
    if (o.planner !== 'workflow') throw new HttpError(404, 'not_found', 'Unknown workflow run')
    return o
  }

  workflowRuns(): WorkflowRunList {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      items: listWorkflowOrchs(sqlite).map((o) =>
        workflowSummaryOf(sqlite, o, this.options.fence.journal),
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
      workflowSummaryOf(sqlite, this.requireWorkflowOrch(sqlite, id), this.options.fence.journal),
    )
  }

  async workflowPreflight(
    workflowId: string,
    version: number,
    agents?: Pick<AgentSummary, 'id' | 'served'>[],
  ): Promise<WorkflowPreflight> {
    const { port } = this.options
    const fake = port.mode === 'fake'
    const checks: WorkflowPreflight['checks'] = []
    const add = (
      id: WorkflowPreflight['checks'][number]['id'],
      status: 'ok' | 'fail' | 'unknown',
      message: string,
    ) => checks.push({ id, status, message })
    const found = this.db.read((sqlite) => readVersion(sqlite, workflowId, version))
    const validation = validateDefinition(found.definition)
    add(
      'definition',
      validation.ok ? 'ok' : 'fail',
      validation.ok
        ? 'The workflow is valid'
        : `${validation.issues.length} problems in the workflow`,
    )
    const known = new Map((agents ?? (await port.listAgents())).map((agent) => [agent.id, agent]))
    const ids = agentIdsOf(found)
    const problems = ids.flatMap((id) => {
      const agent = known.get(id)
      if (!agent) return [`${id} is not a team member`]
      if (!this.db.read((sqlite) => agentAdmits(sqlite, id)))
        return [`${id} is not ready for new work`]
      if (!fake && !agent.served) return [`${id} is not served by Hermes right now`]
      return []
    })
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
    const reserve = workflowReserve(stepBudgetOf(found))
    const fits = this.db.read((sqlite) => this.quotaUsed(sqlite) + reserve <= this.quotaBytes)
    add(
      'quota',
      fits ? 'ok' : 'fail',
      fits ? 'There is room for another run' : 'Run storage is full; remove old runs first',
    )
    return {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
      mapping,
      gatePolicyNotes: {
        'gates-only':
          'Only gate nodes stop for you; agent steps start as soon as their inputs are ready.',
        'every-step': 'You approve every agent step before it starts, as well as the gate nodes.',
      },
      acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
      spendNote:
        'Hermes reports tokens, often not dollars. Unknown cost is shown as unknown, never as zero, and spend of a live Hermes run is not settled: reservations are held until the run ends.',
      maxSteps: found.maxSteps,
      reserveBytes: reserve,
      defaults: { gatePolicy: 'gates-only', maxConcurrentSteps: 2, stepEstimateUsd: 0.5 },
    }
  }

  async createWorkflowRun(
    body: WorkflowRunCreate,
    agents?: Pick<AgentSummary, 'id' | 'served'>[],
  ): Promise<WorkflowRunCreated> {
    const found = this.db.read((sqlite) => readVersion(sqlite, body.workflowId, body.version))
    validateInputs(found, body.inputs)
    const preflight = await this.workflowPreflight(body.workflowId, body.version, agents)
    if (!preflight.ok) {
      const failed = (id: string) =>
        preflight.checks.some((check) => check.id === id && check.status === 'fail')
      const details = { checks: preflight.checks }
      if (failed('global_fence')) throw new HttpError(409, 'fenced', 'Admission is fenced', details)
      if (failed('capacity'))
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity', details)
      if (failed('quota'))
        throw new HttpError(409, 'quota_exhausted', 'There is not enough run storage left', details)
      throw new HttpError(409, 'preflight_failed', 'The preflight failed', details)
    }
    const id = `orc-${randomUUID().slice(0, 8)}`
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      if (isFenced(sqlite)) throw new HttpError(409, 'fenced', 'Admission is fenced')
      if (this.capacityUsed(sqlite) >= ORCH_CAPACITY.runningOrchestrations)
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity')
      if (this.quotaUsed(sqlite) + workflowReserve(stepBudgetOf(found)) > this.quotaBytes)
        throw new HttpError(
          409,
          'quota_exhausted',
          'There is not enough run storage left for this run',
        )
      if (body.deadlineAt !== undefined && body.deadlineAt <= now)
        throw new HttpError(400, 'bad_request', 'The deadline must be in the future')
      // The person must have seen the incarnations the run will be bound to.
      const shown = new Map(body.agentMap.map((entry) => [entry.agentId, entry.incarnation]))
      for (const entry of preflight.mapping) {
        const current = lifecycleOf(sqlite, entry.agentId)?.incarnation_id ?? 'untracked'
        if (shown.get(entry.agentId) !== current || shown.size !== preflight.mapping.length)
          throw new HttpError(
            409,
            'conflict',
            `${entry.agentId} changed; look at the start screen again`,
          )
      }
      insertWorkflowRun(ctx, id, body, found, preflight)
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
  wfRemap(id: string, body: WorkflowRemapDecision) {
    return this.decideWf(id, (ctx) => remapWorkflow(ctx, id, body, this.options.fence.journal))
  }
  wfLimits(id: string, body: LimitsDecision) {
    return this.decideWf(id, (ctx) => setLimits(ctx, id, body))
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
            abandoned ? 'abandoned: not confirmed ended' : 'recovered_text_only',
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
      this.repairRecoveredResults(ctx)
      this.backfillLegacyMappings(ctx)
      for (const o of listOrchs(sqlite)) {
        if (isTerminalStatus(o.status)) continue
        for (const attempt of attemptsOf(sqlite, o.id))
          if (attempt.state === 'send_started') {
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
    // A workflow run's planner is its graph: it runs inside the transaction of whatever woke the run.
    if (o.planner === 'workflow') {
      const planned = planWorkflow(ctx, o)
      o = readOrch(sqlite, orchId) ?? o
      if (planned && o.status !== 'running') touch(ctx, orchId)
    }
    const attempts = attemptsOf(sqlite, orchId)
    const live = attempts.some((a) => ['created', 'send_started', 'running'].includes(a.state))
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
      steps.some((s) => ['pending_gate', 'queued', 'admitted'].includes(s.status)) ||
      inquiriesOf(sqlite, orchId).some((q) => q.status === 'open') ||
      gatesOf(sqlite, orchId).some((g) => g.status === 'open') ||
      attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null)
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
    if (isFenced(sqlite)) return []
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
             WHERE a.state = 'created' AND o.status IN ('running', 'stopping', 'finishing') ORDER BY a.created_at, a.rowid`,
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
    if (view.limitUsd !== null && view.unknownSpend && !o.accepted_unknown_spend)
      return this.pauseFor(ctx, o, 'unknown_spend')
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
      if ((counts.perRun.get(o.id) ?? 0) >= o.max_concurrent_steps) continue
      if (counts.total >= ORCH_CAPACITY.concurrentSteps) continue
      if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent) continue
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
      addStored(sqlite, o.id, Buffer.byteLength(input) * (o.planner === 'workflow' ? 3 : 1))
      counts.perRun.set(o.id, (counts.perRun.get(o.id) ?? 0) + 1)
      counts.perAgent.set(step.agent_id, (counts.perAgent.get(step.agent_id) ?? 0) + 1)
      counts.total++
      touch(ctx, o.id)
    }
  }

  private insertAttempt(
    ctx: Ctx,
    o: OrchRow,
    a: {
      id: string
      kind: 'lead' | 'step'
      stepId: string | null
      n: number
      agentId: string
      incarnation: string
      input: string
      reserved: number
      claim: { from: number; to: number } | null
    },
  ): void {
    const { sqlite, now } = ctx
    const turnId = `orc-turn-${a.id}`
    sqlite
      .prepare(
        `INSERT INTO orc_attempts (id, orchestration_id, kind, step_id, n, agent_id, agent_incarnation, session_id, turn_id, message_id,
           state, input, reserved_usd, claim_from, claim_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        o.id,
        a.kind,
        a.stepId,
        a.n,
        a.agentId,
        a.incarnation,
        a.id,
        turnId,
        `reply:${turnId}`,
        a.input,
        a.reserved,
        a.claim?.from ?? null,
        a.claim?.to ?? null,
        now,
        now,
      )
    // The reply row the run's text attaches to. Never queued by the room dispatcher (orchestration_attempt_id).
    sqlite
      .prepare(
        `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at, orchestration_attempt_id)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `reply:${turnId}`,
        o.room_id,
        a.agentId,
        o.brief_id,
        turnId,
        o.brief_id,
        a.kind === 'lead' ? `Lead turn ${a.n}` : `Step ${a.stepId}`,
        JSON.stringify(
          o.lead_agent_id === null ? o.allowed_agents : [o.lead_agent_id, ...o.allowed_agents],
        ),
        now,
        a.id,
      )
  }

  // ---------------------------------------------------------------------------------------------------- dispatch

  /**
   * Sends one admitted attempt. The transaction that starts the send re-checks every admission rule, mints the
   * capability (lead attempts), and journals `send_started` before it commits; only then is Hermes called. After this
   * point the admission is never replayed: any uncertainty makes the attempt `unknown`.
   */
  private async dispatch(attemptId: string): Promise<boolean> {
    let begun: { attempt: AttemptRow; capability?: string } | undefined
    try {
      begun = await this.mutate((ctx) => this.beginSend(ctx, attemptId))
    } catch (error) {
      // The journal could not record the send, so nothing was sent: fence rather than act without a record.
      this.err(error)
      this.fenceNow('journal_unwritable', error instanceof Error ? error.message : String(error))
      return false
    }
    if (!begun) return false
    const { attempt, capability } = begun
    try {
      const result = await this.options.port.startRun({
        agentId: attempt.agent_id,
        input: attempt.input,
        turnId: attempt.turn_id,
        sessionId: attempt.session_id,
        owner: 'orchestration',
        ...(capability ? { render: (stored: string) => withCapability(stored, capability) } : {}),
      })
      await this.mutate((ctx) => this.recordHandle(ctx, attempt.id, result.runId))
    } catch (error) {
      await this.mutate((ctx) => this.recordSendFailure(ctx, attempt.id, error))
    }
    return true
  }

  private beginSend(
    ctx: Ctx,
    attemptId: string,
  ): { attempt: AttemptRow; capability?: string } | undefined {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'created') return undefined
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
    if (
      isTerminalStatus(o.status) ||
      o.status === 'stopping' ||
      o.status === 'finishing' ||
      attempt.retired
    )
      return refuse(`not dispatched: run ${o.status}`, {
        status: 'not_started',
        disposition: `not_started: run ${o.status}`,
      })
    // Result eligibility of everything the input consumed, judged at send (fix-j 2).
    const withdrawn = inputWithdrawn(sqlite, o.id, attempt)
    if (withdrawn) {
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
    // These keep the attempt `created`: it is sent when the condition clears. The manual hold is read directly: it is
    // independent of the status a remap or a limits decision may have cleared (fix-i 3).
    if (
      o.status === 'paused' ||
      o.manual_paused_at !== null ||
      isFenced(sqlite) ||
      teamPausedAt(sqlite) !== null
    )
      return undefined
    const attempts = attemptsOf(sqlite, o.id)
    if (unknownFenceAttempts(o, attempts).length > 0 || cancelFenceAttempts(o, attempts).length > 0)
      return undefined
    if (agentPausedAt(sqlite, attempt.agent_id) !== null) return undefined
    const incarnation = lifecycleOf(sqlite, attempt.agent_id)?.incarnation_id ?? 'untracked'
    if (incarnation !== attempt.agent_incarnation) {
      if (attempt.kind === 'lead') {
        refuseAttempt(sqlite, attempt, 'not dispatched: the lead agent changed', now)
        // Nothing was sent, so the turn's causes go back to the wake cursor.
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
        this.pauseFor(ctx, o, 'agent_unavailable')
        return undefined
      }
      return refuse('not dispatched: the agent changed', {
        status: 'blocked',
        disposition: 'agent_unavailable: the agent was replaced or removed',
      })
    }
    // Re-checked against the frozen mapping as the last step before Hermes (fix-h item 3).
    const frozen = frozenIncarnation(sqlite, o.id, attempt.agent_id)
    if (frozen !== undefined && frozen !== attempt.agent_incarnation) {
      if (attempt.kind === 'lead') {
        refuseAttempt(sqlite, attempt, 'not dispatched: the lead agent mapping changed', now)
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
        this.pauseFor(ctx, o, 'agent_unavailable')
        return undefined
      }
      return refuse('not dispatched: not the approved agent mapping', {
        status: 'blocked',
        disposition: 'agent_changed: not the agent mapping approved for this run',
      })
    }
    if (!agentAdmits(sqlite, attempt.agent_id)) return undefined
    // The last barrier before Hermes: spend, reservations and the deadline as they are now, not as they were when this
    // attempt was prepared (another send may have been awaiting its reply since).
    const fresh = requireOrch(sqlite, o.id)
    if (fresh.deadline_at !== null && now >= fresh.deadline_at) return undefined
    const view = budgetView(sqlite, fresh)
    if (overBudget(view)) {
      this.pauseFor(ctx, fresh, 'budget')
      return undefined
    }
    if (view.limitUsd !== null && view.unknownSpend && !fresh.accepted_unknown_spend) {
      this.pauseFor(ctx, fresh, 'unknown_spend')
      return undefined
    }
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
    })
    touch(ctx, o.id)
    return { attempt: { ...attempt, state: 'send_started' }, ...(capability ? { capability } : {}) }
  }

  private recordHandle(ctx: Ctx, attemptId: string, runId: string): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt) return
    const o = requireOrch(sqlite, attempt.orchestration_id)
    sqlite
      .prepare(
        `UPDATE orc_attempts SET run_id = ?, state = CASE WHEN state = 'send_started' THEN 'running' ELSE state END, refused_streak = 0, updated_at = ? WHERE id = ?`,
      )
      .run(runId, now, attemptId)
    // A Stop (or finish of a non-requesting attempt) that raced the admission: the handle arrived late; stop it now.
    if (['stopping'].includes(o.status) || isTerminalStatus(o.status) || attempt.retired)
      sqlite
        .prepare(
          'UPDATE orc_attempts SET retired = 1, stop_requested_at = COALESCE(stop_requested_at, ?) WHERE id = ?',
        )
        .run(now, attemptId)
    journalSoft(ctx, () => ctx.journal.append({ kind: 'run_handle', attemptId, runId }))
    touch(ctx, o.id)
  }

  private recordSendFailure(ctx: Ctx, attemptId: string, error: unknown): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'send_started') return
    const o = requireOrch(sqlite, attempt.orchestration_id)
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
            `SELECT * FROM orc_attempts WHERE run_id IS NOT NULL AND (state IN ('running', 'unknown') OR (state = 'abandoned' AND evidence IS NULL) OR (state = 'terminated' AND settled = 0))`,
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
      const ends =
        terminalRun &&
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
    addCause(
      sqlite,
      o.id,
      evidence === 'completed' ? 'step_succeeded' : 'step_failed',
      step.id,
      now,
    )
  }

  // ---------------------------------------------------------------------------------------------------- stops

  /** Delivers owed Stops until Hermes acknowledges. Abandoned attempts keep theirs. */
  private async serviceStops(): Promise<boolean> {
    const owed = this.db.read((sqlite) =>
      z
        .array(AttemptRowSchema)
        .parse(
          sqlite
            .prepare(
              `SELECT * FROM orc_attempts WHERE stop_requested_at IS NOT NULL AND stop_acknowledged_at IS NULL AND run_id IS NOT NULL AND state IN ('send_started', 'running', 'unknown', 'abandoned')`,
            )
            .all(),
        ),
    )
    let changed = false
    for (const attempt of owed) {
      const last = this.stopTried.get(attempt.id) ?? 0
      if (this.nowMs() - last < this.retryMs && last !== 0) continue
      this.stopTried.set(attempt.id, this.nowMs())
      try {
        await this.options.port.stopRun({ agentId: attempt.agent_id, runId: attempt.run_id! })
      } catch (error) {
        this.err(error)
        continue
      }
      await this.mutate((ctx) => {
        ctx.sqlite
          .prepare('UPDATE orc_attempts SET stop_acknowledged_at = ?, updated_at = ? WHERE id = ?')
          .run(ctx.now, ctx.now, attempt.id)
        touch(ctx, attempt.orchestration_id)
      })
      changed = true
    }
    return changed
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
      }
    const compacted = journal.compact((entry) => {
      if (entry.kind === 'send_refused' || entry.kind === 'witness') {
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

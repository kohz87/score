import {
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
  type OrchestrationList,
  type OrchestrationSnapshot,
  type OrchestrationSummary,
  type Preflight,
  type PreflightCheck,
  type AbandonDecision,
  type RunControl,
  type WaiverDecision,
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
import { budgetView, canReserve, overBudget, runSpendReader, type SpendReader } from './budget.ts'
import { containsCapability, hashCapability, mintCapability, withCapability } from './capability.ts'
import { runCommand, type ToolName, parseToolArgs } from './commands.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  abandonAttempts,
  answerInquiry,
  decideGate,
  grantWaiver,
  pauseRun,
  resumeRun,
  setLimits,
  stopRun,
} from './decisions.ts'
import { fenceView, isFenced, type GlobalFenceStore } from './fence.ts'
import {
  activeStepCounts,
  addStored,
  cascadeBlocked,
  refuseAttempt,
  reserveFor,
  setStepStatus,
} from './ops.ts'
import { renderLeadInput, renderStepInput } from './render.ts'
import {
  AttemptRowSchema,
  addCause,
  addHistory,
  attemptsOf,
  causesAfter,
  gatesOf,
  inquiriesOf,
  isTerminalStatus,
  listOrchs,
  readAttempt,
  readOrch,
  requireOrch,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from './store.ts'
import { cancelFenceAttempts, detailOf, summaryOf, unknownFenceAttempts } from './views.ts'

interface RunFacts {
  status: string
  output: string | null
  error: string | null
  ended_at: string | null
}

export const ORCHESTRATION_QUOTA_BYTES = 200 * 1024 * 1024
const SWEEP_MS = 10_000
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export interface OrchestratorOptions {
  db: ScoreDb
  ingest: Ingest
  port: Pick<HermesPort, 'mode' | 'startRun' | 'stopRun' | 'listAgents'>
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
export class Orchestrator {
  private readonly db: ScoreDb
  private readonly ingest: Ingest
  private readonly clock: () => number
  private readonly spend: SpendReader
  private readonly quotaBytes: number
  private readonly retryMs: number
  private pumping: Promise<void> | undefined
  private again = false
  private closed = false
  private timer: NodeJS.Timeout | undefined
  private maintenanceTimer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private readonly cooldown = new Map<string, number>()
  private readonly stopTried = new Map<string, number>()
  private readonly fingerprints = new Map<string, string>()

  constructor(private readonly options: OrchestratorOptions) {
    this.db = options.db
    this.ingest = options.ingest
    this.clock = options.clock ?? Date.now
    this.spend = options.spend ?? runSpendReader
    this.quotaBytes = options.quotaBytes ?? ORCHESTRATION_QUOTA_BYTES
    this.retryMs = options.retryMs ?? 5_000
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

  private async cycle(): Promise<void> {
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
        const events = [...ctx.events, ...this.finalize(ctx)]
        failure = ctx.journalFailure
        return events
      },
    })
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
  private finalize(ctx: Ctx): DomainEventDraft[] {
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
      const fingerprint = createHash('sha1')
        .update(JSON.stringify({ ...detailOf(sqlite, o), revision: 0, updatedAt: '' }))
        .digest('hex')
      if (this.fingerprints.get(id) === fingerprint) continue
      this.fingerprints.set(id, fingerprint)
      sqlite
        .prepare('UPDATE orchestrations SET revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(now, id)
      events.push({
        type: 'orchestration.upserted',
        data: summaryOf(sqlite, readOrch(sqlite, id)!),
      })
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
      items: listOrchs(sqlite).map((o) => summaryOf(sqlite, o)),
    }))
  }

  snapshot(id: string): OrchestrationSnapshot {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      orchestration: detailOf(sqlite, requireOrch(sqlite, id)),
    }))
  }

  summary(id: string): OrchestrationSummary {
    return this.db.read((sqlite) => summaryOf(sqlite, requireOrch(sqlite, id)))
  }

  fenceStore(): GlobalFenceStore {
    return this.options.fence
  }

  // ----------------------------------------------------------------------------------------------- preflight, create

  async preflight(leadAgentId: string, allowedAgents: string[]): Promise<Preflight> {
    const { port, access } = this.options
    const fake = port.mode === 'fake'
    const checks: PreflightCheck[] = []
    const add = (id: PreflightCheck['id'], status: PreflightCheck['status'], message: string) =>
      checks.push({ id, status, message })
    const agents = await port.listAgents()
    const known = new Map(agents.map((agent) => [agent.id, agent]))
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
    const running = this.db.read(
      (sqlite) => listOrchs(sqlite).filter((o) => !isTerminalStatus(o.status)).length,
    )
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
    add(
      'tool_readiness',
      fake ? 'ok' : 'unknown',
      fake
        ? 'Scripted lead'
        : 'Hermes loads MCP tools per session; Score cannot see whether the lead has the orch.* tools. Each lead turn is a new session, so they appear once the profile has the Score MCP entry.',
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

  private quotaUsed(sqlite: DatabaseSync): number {
    return listOrchs(sqlite).reduce(
      (sum, o) =>
        sum +
        (isTerminalStatus(o.status) ? o.stored_bytes : Math.max(o.reserve_bytes, o.stored_bytes)),
      0,
    )
  }

  async create(body: OrchestrationCreate): Promise<OrchestrationCreated> {
    const preflight = await this.preflight(body.leadAgentId, body.allowedAgents)
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
    const live = listOrchs(sqlite).filter((o) => !isTerminalStatus(o.status)).length
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

  // ------------------------------------------------------------------------------------------------------ MCP tools

  /** One `orch.*` call from the MCP server. `agentId` is the token's agent. */
  async handleTool(agentId: string, tool: ToolName, raw: unknown): Promise<ToolResult> {
    const parsed = parseToolArgs(tool, raw)
    if (!parsed.ok)
      return {
        kind: 'receipt',
        receipt: { status: 'refused', code: 'bad_arguments', message: parsed.message, tool },
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
  async recover(): Promise<void> {
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      for (const o of listOrchs(sqlite)) {
        if (isTerminalStatus(o.status)) continue
        for (const attempt of attemptsOf(sqlite, o.id))
          if (attempt.state === 'send_started') {
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
    const o = readOrch(sqlite, orchId)
    if (!o || isTerminalStatus(o.status)) return false
    cascadeBlocked(sqlite, orchId, now)
    const attempts = attemptsOf(sqlite, orchId)
    const live = attempts.some((a) => ['created', 'send_started', 'running'].includes(a.state))
    const end = (status: OrchRow['status'], reason: string | null): boolean => {
      sqlite
        .prepare(
          'UPDATE orchestrations SET status = ?, pause_reason = NULL, ended_at = ?, end_reason = ? WHERE id = ?',
        )
        .run(status, now, reason, orchId)
      addHistory(sqlite, orchId, 'ended', { status, reason }, now)
      return true
    }
    if (o.status === 'stopping') {
      const unresolved = attempts.some((a) => a.state === 'unknown' && a.abandoned_at === null)
      return !live && !unresolved ? end('stopped', 'stopped by the person') : false
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
    if (o.deadline_at !== null && now >= o.deadline_at) {
      this.pauseFor(ctx, o, 'deadline')
      return true
    }
    const steps = stepsOf(sqlite, orchId)
    const wakeSource =
      live ||
      causesAfter(sqlite, orchId, o.causes_consumed_up_to).length > 0 ||
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
      if (o.status !== 'running') continue
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
    if (o.deadline_at !== null && now >= o.deadline_at) return this.pauseFor(ctx, o, 'deadline')
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
    if (!leadLive && pending.length > 0) {
      const life = lifecycleOf(sqlite, o.lead_agent_id)
      const incarnation = life?.incarnation_id ?? 'untracked'
      if (incarnation !== o.lead_incarnation || !agentAdmits(sqlite, o.lead_agent_id))
        return this.pauseFor(ctx, o, 'agent_unavailable')
      if (o.lead_turns_used >= o.max_lead_turns) return this.pauseFor(ctx, o, 'turns_exhausted')
      if (o.consecutive_lead_failures >= 2) return this.pauseFor(ctx, o, 'lead_failing')
      if (!canReserve(view, o.lead_turn_estimate_usd)) return this.pauseFor(ctx, o, 'budget')
      if (agentPausedAt(sqlite, o.lead_agent_id) === null) {
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
          agentId: o.lead_agent_id,
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
      if (!agentAdmits(sqlite, step.agent_id) || agentPausedAt(sqlite, step.agent_id) !== null)
        continue
      if ((counts.perRun.get(o.id) ?? 0) >= o.max_concurrent_steps) continue
      if (counts.total >= ORCH_CAPACITY.concurrentSteps) continue
      if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent) continue
      const dependencies = step.after_steps.map((id) => byId.get(id)!)
      const input = renderStepInput({ o, step, dependencies })
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
      setStepStatus(sqlite, o.id, step.id, 'admitted', null, now)
      addStored(sqlite, o.id, Buffer.byteLength(input))
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
        JSON.stringify([o.lead_agent_id, ...o.allowed_agents]),
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
    const o = requireOrch(sqlite, attempt.orchestration_id)
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
    // These keep the attempt `created`: it is sent when the condition clears.
    if (o.status === 'paused' || isFenced(sqlite) || teamPausedAt(sqlite) !== null) return undefined
    const attempts = attemptsOf(sqlite, o.id)
    if (unknownFenceAttempts(o, attempts).length > 0 || cancelFenceAttempts(o, attempts).length > 0)
      return undefined
    if (agentPausedAt(sqlite, attempt.agent_id) !== null) return undefined
    const incarnation = lifecycleOf(sqlite, attempt.agent_id)?.incarnation_id ?? 'untracked'
    if (incarnation !== attempt.agent_incarnation) {
      if (attempt.kind === 'lead') {
        refuseAttempt(sqlite, attempt, 'not dispatched: the lead agent changed', now)
        this.pauseFor(ctx, o, 'agent_unavailable')
        return undefined
      }
      return refuse('not dispatched: the agent changed', {
        status: 'blocked',
        disposition: 'agent_unavailable: the agent was replaced or removed',
      })
    }
    if (!agentAdmits(sqlite, attempt.agent_id)) return undefined
    let capability: string | undefined
    let generation = 0
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
        "UPDATE orc_attempts SET state = 'send_started', sent_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, attempt.id)
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
        `UPDATE orc_attempts SET run_id = ?, state = CASE WHEN state = 'send_started' THEN 'running' ELSE state END, updated_at = ? WHERE id = ?`,
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
        .prepare('SELECT status, output, error, ended_at FROM runs WHERE id = ?')
        .get(attempt.run_id!) as RunFacts | undefined
      if (!run) continue
      const spend = this.spend(sqlite, attempt)
      const terminalRun = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      const evidence = run.status === 'completed' || run.status === 'failed'
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
      const evidence = run.status === 'completed' || run.status === 'failed'
      const terminalRun = evidence || run.status === 'cancelled' || run.status === 'interrupted'
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
      else this.markUnknown(ctx, o, attempt, `run_${run.status}`)
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
    const body = run.output ?? (messageText || '')
    const result = redactBounded(
      evidence === 'failed' && run.error ? `${body}\n[error] ${run.error}`.trim() : body,
      ORCH_LIMITS.resultBytes,
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
    addStored(sqlite, o.id, Buffer.byteLength(result))
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
    const compacted = journal.compact((entry) => {
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
      if (entry.kind === 'stop_fence') {
        const o = readOrch(sqlite, entry.orchestrationId)
        if (!o || !isTerminalStatus(o.status)) return false
        const attempts = attemptsOf(sqlite, o.id)
        return !attempts.some(
          (a) =>
            a.state === 'unknown' ||
            (a.stop_requested_at !== null && a.stop_acknowledged_at === null),
        )
      }
      return false
    })
    const cutoff = new Date(this.nowMs() - RETENTION_MS).toISOString()
    let pruned = 0
    this.db.tx((tx) => {
      for (const o of listOrchs(tx)) {
        if (!isTerminalStatus(o.status) || (o.ended_at ?? o.updated_at) >= cutoff) continue
        if (
          attemptsOf(tx, o.id).some(
            (a) =>
              a.state === 'unknown' ||
              (a.stop_requested_at !== null && a.stop_acknowledged_at === null),
          )
        )
          continue
        for (const table of [
          'orc_commands',
          'orc_causes',
          'orc_gates',
          'orc_inquiries',
          'orc_steps',
        ])
          tx.prepare(`DELETE FROM ${table} WHERE orchestration_id = ?`).run(o.id)
        tx.prepare(
          'DELETE FROM orc_capabilities WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
        ).run(o.id)
        tx.prepare('DELETE FROM orc_attempts WHERE orchestration_id = ?').run(o.id)
        tx.prepare('DELETE FROM orchestrations WHERE id = ?').run(o.id)
        addHistory(
          tx,
          o.id,
          'pruned',
          { endedAt: o.ended_at, status: o.status },
          new Date(this.nowMs()).toISOString(),
        )
        pruned++
      }
    })
    return { journal: compacted, pruned }
  }
}

import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// Contract §14 "Orchestrator" (PLAN 7.5a; design docs/briefs/7.5-orchestrator.md v3 + v3.1). A lead agent decides steps
// at runtime and hands them to team agents; Score is the referee. These schemas are the browser's view of a run and the
// arguments of the `orch.*` MCP tools.

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length

export const ORCH_LIMITS = {
  goalBytes: 8 * 1024,
  titleChars: 120,
  instructionBytes: 8 * 1024,
  planEntries: 30,
  planEntryBytes: 500,
  noteBytes: 2 * 1024,
  questionBytes: 2 * 1024,
  answerBytes: 4 * 1024,
  summaryBytes: 4 * 1024,
  resultBytes: 8 * 1024,
  commandIdMax: 64,
  commandsPerLeadAttempt: 20,
  leadInputBytes: 64 * 1024,
  stepInputBytes: 32 * 1024,
  maxSteps: 30,
  maxLeadTurns: 40,
  maxConcurrentSteps: 3,
  maxAllowedAgents: 8,
  /** Per run: steps × this + lead turns × this + `controlReserveBytes` for Stop and obligation records. */
  storagePerItemBytes: 64 * 1024,
  controlReserveBytes: 256 * 1024,
} as const

/** Capacity is global, not per run: admitting, stopping, paused-active and unknown work all count. */
export const ORCH_CAPACITY = {
  runningOrchestrations: 5,
  concurrentSteps: 6,
  stepsPerAgent: 2,
} as const

export const ORCH_DEFAULTS = {
  maxSteps: 12,
  maxLeadTurns: 20,
  maxConcurrentSteps: 2,
  leadTurnEstimateUsd: 0.25,
  stepEstimateUsd: 0.5,
} as const

/** `orc_` + 43 base64url characters: a per-turn bearer capability, distinct from `scm_` MCP tokens. */
export const ORC_CAPABILITY_PATTERN = /^orc_[A-Za-z0-9_-]{43}$/
/** Where the rendered lead input carries the capability; replaced only in the payload sent to Hermes. */
export const ORC_CAPABILITY_PLACEHOLDER = '{{SCORE_ORCHESTRATION_CAPABILITY}}'

/** The wording the person must accept to start (both lead and steps; design v2 "Acknowledged unrestricted execution"). */
export const ORCH_ACKNOWLEDGEMENT_TEXT =
  "Score controls the work it starts (turns and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop."

export const CommandIdSchema = z
  .string()
  .min(1)
  .max(ORCH_LIMITS.commandIdMax)
  .regex(/^[A-Za-z0-9._:-]+$/, 'commandId may contain letters, digits and . _ : -')

export const OrchestrationStatusSchema = z.enum([
  'running',
  'paused',
  'stopping',
  'finishing',
  'succeeded',
  'finished_with_unresolved',
  'stopped',
  'failed',
])
export type OrchestrationStatus = z.infer<typeof OrchestrationStatusSchema>

export const GatePolicySchema = z.enum(['every-step', 'lead-asks', 'none'])
export type GatePolicy = z.infer<typeof GatePolicySchema>

export const PauseReasonSchema = z.enum([
  'person',
  'budget',
  'unknown_spend',
  'deadline',
  'no_wake_source',
  'turns_exhausted',
  'lead_failing',
  'agent_unavailable',
  'abandonment',
])
export type PauseReason = z.infer<typeof PauseReasonSchema>

export const StepStatusSchema = z.enum([
  'pending_gate',
  'queued',
  'admitted',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
  'blocked',
  'rejected',
  'not_started',
])
export type StepStatus = z.infer<typeof StepStatusSchema>

export const AttemptStateSchema = z.enum([
  'created',
  'send_started',
  'running',
  'terminated',
  'unknown',
  'refused',
  'abandoned',
])
export type AttemptState = z.infer<typeof AttemptStateSchema>

/** pending: no step has been admitted yet; owned/draining/released as in the transition table (contract §14). */
export const OwnershipStateSchema = z.enum(['owned', 'draining', 'released'])
export type OwnershipState = z.infer<typeof OwnershipStateSchema>

const goal = z
  .string()
  .min(1)
  .refine((v) => utf8Bytes(v) <= ORCH_LIMITS.goalBytes, 'goal is limited to 8 KiB')
  .refine((v) => !v.includes('\0'), 'No NUL')

export const OrchestrationCreateSchema = z
  .object({
    title: z.string().min(1).max(ORCH_LIMITS.titleChars).optional(),
    goal,
    leadAgentId: AgentIdSchema,
    /** Agents the lead may assign to. The lead itself is not allowed here: a step could then call `orch.*` tools. */
    allowedAgents: z.array(AgentIdSchema).min(1).max(ORCH_LIMITS.maxAllowedAgents),
    gatePolicy: GatePolicySchema.default('every-step'),
    budgetUsd: z.number().positive().max(10_000).optional(),
    deadlineAt: z.iso.datetime().optional(),
    maxSteps: z.int().min(1).max(ORCH_LIMITS.maxSteps).default(ORCH_DEFAULTS.maxSteps),
    maxLeadTurns: z.int().min(1).max(ORCH_LIMITS.maxLeadTurns).default(ORCH_DEFAULTS.maxLeadTurns),
    maxConcurrentSteps: z
      .int()
      .min(1)
      .max(ORCH_LIMITS.maxConcurrentSteps)
      .default(ORCH_DEFAULTS.maxConcurrentSteps),
    leadTurnEstimateUsd: z.number().positive().max(1000).default(ORCH_DEFAULTS.leadTurnEstimateUsd),
    stepEstimateUsd: z.number().positive().max(1000).default(ORCH_DEFAULTS.stepEstimateUsd),
    /** Must be exactly `ORCH_ACKNOWLEDGEMENT_TEXT`; recorded on the run. */
    acknowledgement: z.object({ text: z.literal(ORCH_ACKNOWLEDGEMENT_TEXT) }),
  })
  .strict()
export type OrchestrationCreate = z.infer<typeof OrchestrationCreateSchema>

export const PreflightCheckSchema = z.object({
  id: z.enum([
    'listener',
    'lead_ready',
    'lead_mcp_access',
    'lead_mcp_token',
    'allowed_agents',
    'global_fence',
    'journal',
    'capacity',
    'quota',
    'tool_readiness',
  ]),
  /** `unknown` = Score cannot verify it (Hermes loads MCP tools per session); never blocks, always shown. */
  status: z.enum(['ok', 'fail', 'unknown']),
  message: z.string(),
})
export type PreflightCheck = z.infer<typeof PreflightCheckSchema>

export const PreflightSchema = z.object({
  ok: z.boolean(),
  checks: z.array(PreflightCheckSchema),
  gatePolicyNotes: z.object({
    'every-step': z.string(),
    'lead-asks': z.string(),
    none: z.string(),
  }),
  acknowledgementText: z.literal(ORCH_ACKNOWLEDGEMENT_TEXT),
  defaults: z.object({
    maxSteps: z.int(),
    maxLeadTurns: z.int(),
    maxConcurrentSteps: z.int(),
    leadTurnEstimateUsd: z.number(),
    stepEstimateUsd: z.number(),
  }),
  reserveBytes: z.int().nonnegative(),
})
export type Preflight = z.infer<typeof PreflightSchema>

export const BudgetViewSchema = z.object({
  limitUsd: z.number().nullable(),
  /** Spend of settled attempts (terminated, session and lineage closed). */
  settledUsd: z.number().nonnegative(),
  /** Spend still moving: counted by budgets together with the reservations. */
  provisionalUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  /** limit − (settled + provisional + reserved); null without a limit. */
  remainingUsd: z.number().nullable(),
  /** True while any attempt's spend is unknown (never counted as zero). */
  unknownSpend: z.boolean(),
  /** True only when every attempt is settled. */
  complete: z.boolean(),
})
export type BudgetView = z.infer<typeof BudgetViewSchema>

export const AttemptViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['lead', 'step']),
  stepId: z.string().nullable(),
  n: z.int().positive(),
  agentId: AgentIdSchema,
  sessionId: z.string(),
  state: AttemptStateSchema,
  runId: z.string().nullable(),
  retired: z.boolean(),
  stopRequestedAt: z.iso.datetime().nullable(),
  stopAcknowledgedAt: z.iso.datetime().nullable(),
  terminatedAt: z.iso.datetime().nullable(),
  /** `completed` / `failed` from the run's own agent loop; absent = not confirmed ended. */
  evidence: z.enum(['completed', 'failed']).nullable(),
  unknownReason: z.string().nullable(),
  spendUsd: z.number().nullable(),
  spendComplete: z.boolean(),
  abandonedAt: z.iso.datetime().nullable(),
})
export type AttemptView = z.infer<typeof AttemptViewSchema>

export const StepViewSchema = z.object({
  id: z.string().min(1),
  agentId: AgentIdSchema,
  instruction: z.string(),
  after: z.array(z.string()),
  replaces: z.string().nullable(),
  status: StepStatusSchema,
  disposition: z.string().nullable(),
  estimateUsd: z.number(),
  /** Redacted, ≤ 8 KiB. */
  result: z.string().nullable(),
  resultRevision: z.int().nonnegative(),
  gateId: z.string().nullable(),
  attemptId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type StepView = z.infer<typeof StepViewSchema>

export const GateViewSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  requestedBy: z.enum(['policy', 'lead']),
  status: z.enum(['open', 'approved', 'rejected', 'withdrawn']),
  /** The frozen payload the decision applies to; the decision approves exactly this. */
  payload: z.object({
    agentId: AgentIdSchema,
    agentIncarnation: z.string(),
    instruction: z.string(),
    after: z.array(z.string()),
    replaces: z.string().nullable(),
    estimateUsd: z.number(),
    /** Result revisions of the dependencies the lead saw when it assigned the step. */
    dependencyRevisions: z.record(z.string(), z.int().nonnegative()),
  }),
  payloadHash: z.string(),
  revision: z.int().positive(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
})
export type GateView = z.infer<typeof GateViewSchema>

export const InquiryViewSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  status: z.enum(['open', 'answered', 'withdrawn']),
  answer: z.string().nullable(),
  revision: z.int().positive(),
  createdAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
})
export type InquiryView = z.infer<typeof InquiryViewSchema>

export const NeedsYouSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gate'), gateId: z.string(), stepId: z.string() }),
  z.object({ kind: z.literal('inquiry'), inquiryId: z.string() }),
  z.object({ kind: z.literal('budget'), reason: PauseReasonSchema }),
  z.object({ kind: z.literal('paused'), reason: PauseReasonSchema }),
  z.object({ kind: z.literal('unknown'), attemptId: z.string() }),
  z.object({ kind: z.literal('cancel_fence'), stepId: z.string(), attemptId: z.string() }),
  z.object({ kind: z.literal('fence'), reason: z.string() }),
])
export type NeedsYou = z.infer<typeof NeedsYouSchema>

export const OrchestrationSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: OrchestrationStatusSchema,
  pauseReason: PauseReasonSchema.nullable(),
  leadAgentId: AgentIdSchema,
  roomId: z.string().min(1),
  briefId: z.string().min(1),
  gatePolicy: GatePolicySchema,
  revision: z.int().positive(),
  ownership: OwnershipStateSchema,
  steps: z.object({
    total: z.int().nonnegative(),
    active: z.int().nonnegative(),
    succeeded: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  leadTurnsUsed: z.int().nonnegative(),
  maxLeadTurns: z.int().positive(),
  needsYou: z.array(NeedsYouSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
})
export type OrchestrationSummary = z.infer<typeof OrchestrationSummarySchema>

export const OrchestrationListSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(OrchestrationSummarySchema),
})
export type OrchestrationList = z.infer<typeof OrchestrationListSchema>

export const OrchestrationDetailSchema = OrchestrationSummarySchema.extend({
  goal: z.string(),
  allowedAgents: z.array(AgentIdSchema),
  plan: z.array(z.string()),
  maxSteps: z.int().positive(),
  maxConcurrentSteps: z.int().positive(),
  deadlineAt: z.iso.datetime().nullable(),
  leadTurnEstimateUsd: z.number(),
  stepEstimateUsd: z.number(),
  budget: BudgetViewSchema,
  stepsList: z.array(StepViewSchema),
  attempts: z.array(AttemptViewSchema),
  gates: z.array(GateViewSchema),
  inquiries: z.array(InquiryViewSchema),
  finish: z
    .object({
      requestedAt: z.iso.datetime(),
      outcome: z.enum(['success', 'partial', 'failed']),
      summary: z.string(),
    })
    .nullable(),
  /** Attempts not confirmed ended; the Stop owed on each is retried until Hermes confirms. */
  unconfirmed: z.array(z.string()),
  /** A cancelled step's attempt that may still run: the whole run admits nothing until it ends or `waiver`. */
  cancelFence: z.array(z.object({ stepId: z.string(), attemptId: z.string() })),
  waiverAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime(),
  endReason: z.string().nullable(),
  storage: z.object({ reserveBytes: z.int(), storedBytes: z.int() }),
})
export type OrchestrationDetail = z.infer<typeof OrchestrationDetailSchema>

/** **S**: `asOfSeq` is read in the same transaction as the data. */
export const OrchestrationSnapshotSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  orchestration: OrchestrationDetailSchema,
})
export type OrchestrationSnapshot = z.infer<typeof OrchestrationSnapshotSchema>

export const FenceItemSchema = z.object({
  kind: z.enum(['attempt', 'handle', 'fence', 'journal', 'restore']),
  ref: z.string(),
  detail: z.string(),
})
export type FenceItem = z.infer<typeof FenceItemSchema>

export const GlobalFenceSchema = z.object({
  fenced: z.boolean(),
  reason: z.string().nullable(),
  untrustedHistory: z.boolean(),
  revision: z.int().positive(),
  since: z.iso.datetime().nullable(),
  items: z.array(FenceItemSchema),
  journal: z.object({
    ok: z.boolean(),
    entries: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    sizeAlarm: z.boolean(),
  }),
})
export type GlobalFence = z.infer<typeof GlobalFenceSchema>

const revision = z.int().positive()

export const GateDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    expectedRevision: revision,
    /** The run's revision the page showed; a stale one is `409 conflict`. */
    orchestrationRevision: revision,
    note: z.string().max(500).optional(),
  })
  .strict()
export type GateDecision = z.infer<typeof GateDecisionSchema>

export const InquiryAnswerSchema = z
  .object({
    answer: z
      .string()
      .min(1)
      .refine((v) => utf8Bytes(v) <= ORCH_LIMITS.answerBytes, 'answer is limited to 4 KiB'),
    expectedRevision: revision,
    orchestrationRevision: revision,
  })
  .strict()
export type InquiryAnswer = z.infer<typeof InquiryAnswerSchema>

export const LimitsDecisionSchema = z
  .object({
    budgetUsd: z.number().positive().max(10_000).nullable().optional(),
    deadlineAt: z.iso.datetime().nullable().optional(),
    /** Continue although spend is unknown (otherwise unknown spend keeps the run paused). */
    acceptUnknownSpend: z.boolean().optional(),
    orchestrationRevision: revision,
  })
  .strict()
  .refine(
    (v) =>
      v.budgetUsd !== undefined || v.deadlineAt !== undefined || v.acceptUnknownSpend !== undefined,
  )
export type LimitsDecision = z.infer<typeof LimitsDecisionSchema>

export const RunControlSchema = z.object({ orchestrationRevision: revision }).strict()
export type RunControl = z.infer<typeof RunControlSchema>

/** "Continue while the cancelled step may still run": recorded; never termination evidence. */
export const WaiverDecisionSchema = z
  .object({ orchestrationRevision: revision, acknowledge: z.literal(true) })
  .strict()
export type WaiverDecision = z.infer<typeof WaiverDecisionSchema>

export const AbandonDecisionSchema = z
  .object({
    attemptIds: z.array(z.string().min(1)).min(1).max(40),
    orchestrationRevision: revision,
    /** "These may still be running; Score will keep trying to stop them and will ignore their late results." */
    acknowledge: z.literal(true),
  })
  .strict()
export type AbandonDecision = z.infer<typeof AbandonDecisionSchema>

export const FenceLiftSchema = z
  .object({
    expectedRevision: revision,
    /** The person went through the reconciliation list. */
    reviewed: z.literal(true),
    note: z.string().max(500).optional(),
  })
  .strict()
export type FenceLift = z.infer<typeof FenceLiftSchema>

export const OrchestrationCreatedSchema = z.object({
  orchestration: OrchestrationSummarySchema,
  preflight: PreflightSchema,
})
export type OrchestrationCreated = z.infer<typeof OrchestrationCreatedSchema>

// ---------------------------------------------------------------------------------------------------------------
// MCP tools (`orch.*`). Every call carries the per-turn capability and a lead-chosen commandId.

const toolBase = {
  capability: z.string().regex(ORC_CAPABILITY_PATTERN),
  commandId: CommandIdSchema,
}
const bytes = (max: number) =>
  z
    .string()
    .min(1)
    .refine((v) => utf8Bytes(v) <= max, `limited to ${max} bytes`)
    .refine((v) => !v.includes('\0'), 'No NUL')

export const OrchPlanArgsSchema = z.object({
  ...toolBase,
  entries: z.array(bytes(ORCH_LIMITS.planEntryBytes)).max(ORCH_LIMITS.planEntries),
})
export const OrchAssignArgsSchema = z.object({
  ...toolBase,
  agent: AgentIdSchema,
  instruction: bytes(ORCH_LIMITS.instructionBytes),
  after: z.array(z.string().min(1).max(64)).max(ORCH_LIMITS.maxSteps).optional(),
  replaces: z.string().min(1).max(64).optional(),
})
export const OrchCancelArgsSchema = z.object({ ...toolBase, stepId: z.string().min(1).max(64) })
export const OrchAskArgsSchema = z.object({
  ...toolBase,
  question: bytes(ORCH_LIMITS.questionBytes),
})
export const OrchRequestApprovalArgsSchema = z.object({
  ...toolBase,
  stepId: z.string().min(1).max(64),
})
export const OrchNoteArgsSchema = z.object({ ...toolBase, text: bytes(ORCH_LIMITS.noteBytes) })
export const OrchFinishArgsSchema = z.object({
  ...toolBase,
  outcome: z.enum(['success', 'partial', 'failed']),
  summary: bytes(ORCH_LIMITS.summaryBytes),
})
export const OrchReceiptArgsSchema = z.object({
  capability: toolBase.capability,
  commandId: CommandIdSchema,
})

export const OrchReceiptSchema = z.object({
  status: z.enum(['ok', 'refused', 'retry', 'conflict', 'not_found']),
  commandId: z.string().optional(),
  tool: z.string().optional(),
  /** Machine-readable refusal code (`agent_not_allowed`, `step_limit`, `budget_exceeded`, ...). */
  code: z.string().optional(),
  message: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
})
export type OrchReceipt = z.infer<typeof OrchReceiptSchema>

// ---------------------------------------------------------------------------------------------------------------
// Event history (PLAN 7.5b): what the live diagram, the live log and the replay are drawn from. Derived on read from
// the persisted rows (commands with their receipts, attempts, gates, inquiries, causes, history), so nothing is
// invented client-side and no migration is needed.

export const OrchEventKindSchema = z.enum([
  'run_started',
  'lead_wake',
  'lead_done',
  /** An orch.* call and Score's verdict on it. */
  'command',
  'step_admitted',
  'step_result',
  /** A step changed state without a result (blocked, unknown, abandoned). */
  'step_state',
  'gate_opened',
  'gate_decided',
  'inquiry_opened',
  'inquiry_answered',
  /** Stop, pause, resume, limits, waiver, abandonment, finish request, end. */
  'control',
])
export type OrchEventKind = z.infer<typeof OrchEventKindSchema>

export const OrchEventSchema = z.object({
  /** Stable across reads, so a client can tell which events are new. */
  id: z.string().min(1),
  at: z.iso.datetime(),
  kind: OrchEventKindSchema,
  stepId: z.string().nullable(),
  attemptId: z.string().nullable(),
  /** `command`: the tool (`orch.assign`, …). */
  tool: z.string().nullable(),
  /** `command`: Score's verdict. `step_result`: `succeeded` or `failed`. `gate_decided`: approved/rejected/withdrawn. */
  verdict: z.string().nullable(),
  /** `command` refusals: the machine-readable code (`budget_exceeded`, …). */
  code: z.string().nullable(),
  /** One redacted line for the log (≤ 300 characters). */
  summary: z.string(),
})
export type OrchEvent = z.infer<typeof OrchEventSchema>

export const OrchestrationEventsSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  events: z.array(OrchEventSchema),
})
export type OrchestrationEvents = z.infer<typeof OrchestrationEventsSchema>

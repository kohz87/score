import { z } from 'zod'
import { QuotaFloorSchema } from './coding.ts'
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
  /** How many coding launches one run may release (7.7b §8); the default is `ORCH_DEFAULTS.codingSteps`. */
  maxCodingSteps: 100,
  /** Per run: steps × this + lead turns × this + `controlReserveBytes` for Stop and obligation records. */
  storagePerItemBytes: 64 * 1024,
  /** Per item: receipts, transitions, gates, associations and replay records the item can cause. */
  recordsPerItemBytes: 8 * 1024,
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
  codingSteps: 10,
} as const

/** `orc_` + 43 base64url characters: a per-turn bearer capability, distinct from `scm_` MCP tokens. */
export const ORC_CAPABILITY_PATTERN = /^orc_[A-Za-z0-9_-]{43}$/
/** Where the rendered lead input carries the capability; replaced only in the payload sent to Hermes. */
export const ORC_CAPABILITY_PLACEHOLDER = '{{SCORE_ORCHESTRATION_CAPABILITY}}'

/** The wording the person must accept to start (both lead and steps; design v2 "Acknowledged unrestricted execution"). */
export const ORCH_ACKNOWLEDGEMENT_TEXT =
  "Score controls the work it starts (exchanges and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop."

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

/** The id of a coding worker's policy: the sha-256 of its canonical JSON (7.7b §3). */
export const PolicyIdSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** Where a cost comes from. An unknown cost is tracked, and accepted, per source (7.7b §8). */
export const CostSourceSchema = z.enum(['hermes', 'claude-code', 'codex'])
export type CostSource = z.infer<typeof CostSourceSchema>

/** Whether a coding agent can take a step now. `changed` is for a started run whose agent no longer matches its policy. */
export const WorkerReadinessSchema = z.enum([
  'ready',
  'not_installed',
  'version_untested',
  'level_unverified',
  'reach_unverifiable',
  'changed',
  'paused',
  'frozen',
  'needs_units',
])
export type WorkerReadiness = z.infer<typeof WorkerReadinessSchema>

/** "I accept what these workers can reach": the policy ids the person saw (an old acknowledgement never carries over). */
export const CodingReachAcknowledgementSchema = z
  .object({ policyIds: z.array(PolicyIdSchema).max(ORCH_LIMITS.maxAllowedAgents) })
  .strict()
export type CodingReachAcknowledgement = z.infer<typeof CodingReachAcknowledgementSchema>

const goal = z
  .string()
  .min(1)
  .refine((v) => utf8Bytes(v) <= ORCH_LIMITS.goalBytes, 'goal is limited to 8 KiB')
  .refine((v) => !v.includes('\0'), 'No NUL')

/**
 * 3.13 (decision 150): the oracle. A command the person sets, run in a workspace; exit code 0 passes. A successful finish
 * needs a pass that started after the last step attempt ended. Only the person writes it; the lead can only run it.
 */
export const ORCH_CHECK_LIMITS = {
  commandChars: 4096,
  maxArgs: 64,
  defaultTimeoutSec: 600,
  maxTimeoutSec: 3600,
} as const
export const OrchestrationCheckSchema = z
  .object({
    /** One line; split into arguments without a shell (quotes and backslashes only). */
    command: z
      .string()
      .trim()
      .min(1)
      .max(ORCH_CHECK_LIMITS.commandChars)
      .refine((v) => !/[\r\n\0]/.test(v)),
    /** An absolute folder the Workspace roots allow. */
    workspace: z.string().min(1).max(4096).startsWith('/'),
    timeoutSec: z
      .int()
      .min(10)
      .max(ORCH_CHECK_LIMITS.maxTimeoutSec)
      .default(ORCH_CHECK_LIMITS.defaultTimeoutSec),
    /** Before finishing only (the lead runs it), or also after every step that succeeds (a formatter, a linter). */
    when: z.enum(['finish', 'each_step']).default('finish'),
  })
  .strict()
export type OrchestrationCheck = z.infer<typeof OrchestrationCheckSchema>
export const CheckOutcomeSchema = z.enum([
  'queued',
  'cancelled',
  'running',
  'passed',
  'failed',
  'timed_out',
  'interrupted',
  'refused',
])
export const CheckRunViewSchema = z.object({
  id: z.string().min(1),
  /** Who asked for it: the lead (orch.check), a step that succeeded (when = each_step), or the person. */
  reason: z.enum(['lead', 'step', 'person']),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  exitCode: z.int().nullable(),
  outcome: CheckOutcomeSchema,
  /** The last part of what it printed, redacted. */
  output: z.string(),
  /** Started after the last step attempt ended, so a pass counts for finishing. */
  current: z.boolean(),
})
export type CheckRunView = z.infer<typeof CheckRunViewSchema>

/**
 * 3.15 (decision 150): helpers, a swarm of (usually cheap) agents for narrow, read-only work the lead hands out with a role,
 * in their own slots and step allowance. `scan` has them read the folder first (stack, scripts, risks) before the lead's
 * first turn. 3.16: they also answer the lead's votes; `splitTo` says who decides a split vote.
 */
export const HelperRoleSchema = z.enum(['search', 'grep', 'audit'])
export const OrchestrationHelpersSchema = z
  .object({
    agentIds: z.array(AgentIdSchema).min(1).max(4),
    maxConcurrent: z.int().min(1).max(6).default(3),
    /** null = no separate limit: helper work runs until the job ends (bounded by its budget, launches and lead turns). */
    maxSteps: z.int().min(1).max(500).nullable().default(20),
    scan: z.boolean().default(false),
    /** The folder the scan reads (absolute; the Workspace rules apply). Needed with `scan` unless the check has one. */
    scanFolder: z.string().min(1).max(4096).startsWith('/').optional(),
    splitTo: z.enum(['lead', 'person']).default('lead'),
    /** 3.13.1: who answers votes (e.g. one model kept for voting); empty or absent = the helpers. */
    voterIds: z.array(AgentIdSchema).max(4).optional(),
    /** 3.14: before each step the lead assigns starts, the voters judge it (k answers); not under every-step approval. */
    autoVote: z.boolean().default(false),
    autoVoteK: z.int().min(3).max(7).default(3),
    /** 3.14: after each step the lead assigned succeeds, a helper audits the change; its findings reach the lead. */
    autoAudit: z.boolean().default(false),
  })
  .strict()
export const VoteViewSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  options: z.array(z.string()),
  k: z.int().positive(),
  status: z.enum(['voting', 'sharp', 'split', 'failed']),
  /** Votes per option (same order as `options`); unusable answers are not counted. */
  counts: z.array(z.int().nonnegative()),
  /** The winning option's index when sharp, else null. */
  choice: z.int().nonnegative().nullable(),
  /** The top option's share of the usable votes (0–1), once tallied. */
  share: z.number().min(0).max(1).nullable(),
  /** A split sent to the person: the question they were asked. */
  inquiryId: z.string().nullable(),
  /** 3.14: the step this vote judged before it started (automatic votes); null for the lead's own votes. */
  stepId: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
})
export type VoteView = z.infer<typeof VoteViewSchema>

/** 3.14: what an unlimited helper allowance is sized as (storage and coding reserves, the suggested launches). */
export const HELPER_STEPS_UNLIMITED_SIZING = 60

/**
 * 3.13.1: how many coding-agent launches a lead job should allow. Every helper step, vote answer and advisor consult on a
 * coding agent is one launch, on top of the coding workers' own steps; the cap is `ORCH_LIMITS.maxCodingSteps`.
 */
export function suggestedCodingSteps(args: {
  codingHelpers: boolean
  /** null = no helper limit: sized as `HELPER_STEPS_UNLIMITED_SIZING`. */
  helperSteps: number | null
  codingAdvisor: boolean
}): number {
  const advisorConsults = 5
  return Math.min(
    ORCH_LIMITS.maxCodingSteps,
    ORCH_DEFAULTS.codingSteps +
      (args.codingHelpers ? (args.helperSteps ?? HELPER_STEPS_UNLIMITED_SIZING) : 0) +
      (args.codingAdvisor ? advisorConsults : 0),
  )
}

export const AdvisorCheckpointSchema = z.enum(['before_plan', 'repeat_failure', 'before_done'])
export const AdvisorConsultViewSchema = z.object({
  stepId: z.string().min(1),
  checkpoint: AdvisorCheckpointSchema,
  /** Why Score asked (the repeated failure, in Score's words). */
  reason: z.string(),
  status: StepStatusSchema,
  /** The advice, redacted; null until it arrives. */
  advice: z.string().nullable(),
  createdAt: z.iso.datetime(),
})
export type AdvisorConsultView = z.infer<typeof AdvisorConsultViewSchema>

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
    /** 7.7b: the policy id the person saw for each coding worker among `allowedAgents` (`409 policy_changed` otherwise). */
    codingPolicies: z.record(AgentIdSchema, PolicyIdSchema).optional(),
    /** 7.7b: required for every worker whose reach goes beyond its workspace. */
    acknowledgeCodingReach: CodingReachAcknowledgementSchema.optional(),
    /** 7.7b: sources whose unknown cost the person accepts from the start. */
    acceptUnknownCost: z.array(CostSourceSchema).max(3).optional(),
    /** 7.7b: how many coding launches the run may release. */
    codingSteps: z.int().min(1).max(ORCH_LIMITS.maxCodingSteps).optional(),
    /** 8.6: the quota floor for every coding agent of this run; omitted = each agent's own floor. */
    quotaFloorPercent: QuotaFloorSchema.optional(),
    /** 3.13: the oracle (needs the security password or passkey confirmed in the last minute). */
    check: OrchestrationCheckSchema.optional(),
    /**
     * 3.14: an agent Score consults by itself at three checkpoints (before the plan, after the same failure twice, before
     * done). Not the lead; its advice is data for the lead, never a veto.
     */
    advisorAgentId: AgentIdSchema.optional(),
    /**
     * Retired in 3.14.1: accepted and ignored. A worker's own advisor is now a Claude Code agent setting
     * (`CodingAgent.advisorModel`); the job's advisor keeps the lead's checkpoints.
     */
    advisorMode: z.enum(['on_call', 'checkpoints']).optional(),
    /** 3.15: the helpers and their limits. */
    helpers: OrchestrationHelpersSchema.optional(),
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

/** What preflight says about one coding worker (7.7b §3). The policy id is what `POST /api/orchestrations` must echo. */
export const CodingWorkerPreflightSchema = z.object({
  agentId: AgentIdSchema,
  runtime: z.enum(['claude-code', 'codex']),
  readiness: WorkerReadinessSchema,
  /** Why it isn't ready, in a sentence; null when it is. */
  detail: z.string().nullable(),
  policyId: PolicyIdSchema.nullable(),
  /** What the worker can reach, in plain words; null when no policy could be computed. */
  reach: z.string().nullable(),
  /** True when the reach goes beyond the worker's workspace: the person has to acknowledge it. */
  reachBeyondWorkspace: z.boolean(),
})
export type CodingWorkerPreflight = z.infer<typeof CodingWorkerPreflightSchema>

export const PreflightSchema = z.object({
  ok: z.boolean(),
  checks: z.array(PreflightCheckSchema),
  /** One entry per coding worker among the step agents; empty for a run with Hermes agents only. */
  workers: z.array(CodingWorkerPreflightSchema),
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
    codingSteps: z.int(),
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

/** 8.6: why a step is held, and what it waits for. `override` = the person said "Use it anyway" for this step. */
export const QuotaHoldViewSchema = z.object({
  agentId: AgentIdSchema,
  window: z.enum(['5 hours', 'week']),
  group: z.string().nullable(),
  leftPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime(),
  state: z.enum(['held', 'waiting', 'override']),
})
export type QuotaHoldView = z.infer<typeof QuotaHoldViewSchema>

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
  /** 8.6: set while the step's coding agent is below its quota floor. */
  quotaHold: QuotaHoldViewSchema.nullable().optional(),
  /** 3.14: a consult Score started for the advisor (not the lead's work); absent or null for ordinary steps. */
  role: z.enum(['advisor', 'helper', 'vote']).nullable().optional(),
  /** 3.15: a helper step's role (search, grep, audit, or a scan part). */
  helperRole: z.string().nullable().optional(),
  /** 3.14: when its current run last showed a sign of life (a running step quiet for long is stuck). */
  lastActivityAt: z.iso.datetime().nullable().optional(),
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
    /** 7.7b: a coding worker's policy id when the gate was opened; an approval never covers another policy. */
    policyId: PolicyIdSchema.optional(),
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
  /** 7.7b: a coding worker's settings changed since the run was approved; "Use the new settings" is a policy-only remap. */
  z.object({
    kind: z.literal('policy_changed'),
    stepId: z.string(),
    agentId: AgentIdSchema,
    /** The worker's policy id now, or null when it isn't ready. */
    currentPolicyId: PolicyIdSchema.nullable(),
  }),
  /** 7.7b: the run reached its coding step limit; raising `codingSteps` lets the blocked step go on. */
  z.object({ kind: z.literal('coding_limit'), stepId: z.string() }),
  /** 8.6: a step is held because its coding agent has less than its quota floor left. */
  z.object({
    kind: z.literal('quota_low'),
    stepId: z.string(),
    agentId: AgentIdSchema,
    window: z.enum(['5 hours', 'week']),
    group: z.string().nullable(),
    leftPercent: z.number().min(0).max(100),
    resetsAt: z.iso.datetime(),
  }),
  /** An agent was replaced after the run started: the run keeps working with the agent it was started with. */
  z.object({
    kind: z.literal('remap'),
    agentId: AgentIdSchema,
    role: z.enum(['lead', 'agent']),
    /** The incarnation the run was started with (or last remapped to). */
    frozenIncarnation: z.string().min(1),
    /** The agent's incarnation now; `untracked` when the agent no longer exists (only Stop is possible then). */
    currentIncarnation: z.string().min(1),
  }),
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
  /** 8.6: the run's quota floor; null = each coding agent's own. */
  quotaFloorPercent: QuotaFloorSchema.nullable().optional(),
  /** 3.15: the helpers, their limits and use; 3.16: the votes (oldest first). Null = no helpers. */
  helpers: z
    .object({
      agentIds: z.array(AgentIdSchema),
      maxConcurrent: z.int(),
      maxSteps: z.int().nullable(),
      used: z.int(),
      autoVote: z.boolean().optional(),
      autoVoteK: z.int().optional(),
      autoAudit: z.boolean().optional(),
      scan: z.boolean(),
      scanFolder: z.string().nullable(),
      splitTo: z.enum(['lead', 'person']),
      /** Who answers votes; empty = the helpers. */
      voterIds: z.array(AgentIdSchema).optional(),
      votes: z.array(VoteViewSchema),
    })
    .nullable()
    .optional(),
  /** 3.14: the advisor and its consults (oldest first); null = no advisor. */
  advisor: z
    .object({
      agentId: AgentIdSchema,
      consults: z.array(AdvisorConsultViewSchema),
    })
    .nullable()
    .optional(),
  /**
   * 3.14.1: each time a worker asked its own advisor (a Claude Code agent's `advisorModel`, Claude Code's `--advisor`),
   * oldest first. The advice is encrypted for the worker: Score has only that it asked.
   */
  workerAdvisorAsks: z
    .array(
      z.object({
        stepId: z.string(),
        agentId: AgentIdSchema,
        at: z.iso.datetime(),
        status: z.enum(['running', 'done', 'failed']),
      }),
    )
    .optional(),
  /** 3.13: the oracle and its runs (newest first); null = no check. */
  check: z
    .object({
      command: z.string(),
      workspace: z.string(),
      timeoutSec: z.int(),
      when: z.enum(['finish', 'each_step']),
      runs: z.array(CheckRunViewSchema),
      /** The person let the run finish without a passing check. */
      waivedAt: z.iso.datetime().nullable(),
    })
    .nullable()
    .optional(),
  /** 7.7b: the run's coding limits and the policy each coding worker was approved with. */
  coding: z
    .object({
      stepLimit: z.int().positive(),
      acceptedUnknownCost: z.array(CostSourceSchema),
      workers: z.array(
        z.object({
          agentId: AgentIdSchema,
          runtime: z.enum(['claude-code', 'codex']),
          policyId: PolicyIdSchema,
          reach: z.string(),
          reachBeyondWorkspace: z.boolean(),
        }),
      ),
    })
    .optional(),
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
    /** 7.7b: raise or lower how many coding launches the run may release. */
    codingSteps: z.int().min(1).max(ORCH_LIMITS.maxCodingSteps).optional(),
    /** 7.7b: accept (or stop accepting) unknown cost for single sources. */
    acceptUnknownCost: z
      .object({
        add: z.array(CostSourceSchema).max(3).optional(),
        remove: z.array(CostSourceSchema).max(3).optional(),
      })
      .strict()
      .optional(),
    /** 8.6: change the run's quota floor; `null` goes back to each coding agent's own. */
    quotaFloorPercent: QuotaFloorSchema.nullable().optional(),
    orchestrationRevision: revision,
  })
  .strict()
  .refine(
    (v) =>
      v.quotaFloorPercent !== undefined ||
      v.budgetUsd !== undefined ||
      v.deadlineAt !== undefined ||
      v.acceptUnknownSpend !== undefined ||
      v.codingSteps !== undefined ||
      v.acceptUnknownCost !== undefined,
  )
export type LimitsDecision = z.infer<typeof LimitsDecisionSchema>

export const RunControlSchema = z.object({ orchestrationRevision: revision }).strict()
export type RunControl = z.infer<typeof RunControlSchema>

/** "Continue while the cancelled step may still run": recorded; never termination evidence. */
export const WaiverDecisionSchema = z
  .object({ orchestrationRevision: revision, acknowledge: z.literal(true) })
  .strict()
export type WaiverDecision = z.infer<typeof WaiverDecisionSchema>

/** "Use the new <agent> for this run": paired with the exact incarnations the page showed. */
export const RemapDecisionSchema = z
  .object({
    agentId: AgentIdSchema,
    frozenIncarnation: z.string().min(1),
    currentIncarnation: z.string().min(1),
    orchestrationRevision: revision,
    acknowledge: z.literal(true),
    /** 7.7b: for a coding worker, the new agent's policy id and the acknowledgement of its reach. */
    policyId: PolicyIdSchema.optional(),
    acknowledgeCodingReach: CodingReachAcknowledgementSchema.optional(),
  })
  .strict()
export type RemapDecision = z.infer<typeof RemapDecisionSchema>

/** 7.7b §12a: "Use the new settings" for a step blocked `agent_changed`: the same agent, a new policy id. */
export const PolicyRemapDecisionSchema = z
  .object({
    agentId: AgentIdSchema,
    policyId: PolicyIdSchema,
    acknowledgeCodingReach: CodingReachAcknowledgementSchema.optional(),
    orchestrationRevision: revision,
  })
  .strict()
export type PolicyRemapDecision = z.infer<typeof PolicyRemapDecisionSchema>

/** 8.6: the three answers to a held step: use the agent anyway (once), wait for its reset, or stop the run. */
export const QuotaDecisionSchema = z
  .object({
    answer: z.enum(['use_anyway', 'wait', 'stop']),
    orchestrationRevision: revision,
  })
  .strict()
export type QuotaDecision = z.infer<typeof QuotaDecisionSchema>

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
  /** 3.15: hand the step to a helper with a role (its own slots and allowance; read-only by instruction). */
  role: HelperRoleSchema.optional(),
  instruction: bytes(ORCH_LIMITS.instructionBytes),
  after: z.array(z.string().min(1).max(64)).max(ORCH_LIMITS.maxSteps).optional(),
  replaces: z.string().min(1).max(64).optional(),
  /** Under `lead-asks`: create the approval gate in this same call, so the step cannot start before the answer. */
  needsApproval: z.boolean().optional(),
  /** 8.6: when the agent is below its quota floor, hold the step for the person instead of being refused. */
  ifQuotaLow: z.literal('ask_owner').optional(),
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
/** 3.16: ask the helpers the same multiple-choice question; a clear majority (≥ 70%) is "sharp". */
export const OrchVoteArgsSchema = z.object({
  ...toolBase,
  question: bytes(1024),
  options: z.array(z.string().min(1).max(200)).min(2).max(6),
  k: z.int().min(3).max(7).default(5),
})

/** 3.13: run the person's check now (no arguments: the lead can't change it). */
export const OrchCheckArgsSchema = z.object({ ...toolBase })

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

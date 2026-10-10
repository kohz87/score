import { z } from 'zod'
import {
  AttemptViewSchema,
  BudgetViewSchema,
  type GateDecision,
  GateViewSchema,
  OrchEventKindSchema,
  OrchEventSchema,
  OwnershipStateSchema,
  PauseReasonSchema,
  PreflightCheckSchema,
  StepViewSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
} from './orchestration.ts'
import { AgentIdSchema } from './types.ts'

// Contract §15 "Workflows" (PLAN 7.1a; design docs/briefs/7.1-workflow-builder.md v8 .. v8.3). A workflow run IS an
// orchestration whose planner is a fixed graph instead of a lead model (`planner = 'workflow'`): the executor, its
// admission authority, journal, fences, budgets and obligations are §14's. These schemas are the browser's view of
// definitions and runs, plus the decisions only workflows have. Run-level controls reuse §14's request bodies.

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length
const noNul = (v: string): boolean => !v.includes('\0')

export const WORKFLOW_LIMITS = {
  nameChars: 120,
  descriptionChars: 500,
  labelChars: 80,
  maxNodes: 30,
  maxEdges: 100,
  maxInputs: 10,
  inputLabelChars: 80,
  inputMaxChars: 4 * 1024,
  /** All start inputs of a run together. */
  startInputsBytes: 16 * 1024,
  /** The authored instruction template. */
  instructionBytes: 32 * 1024,
  questionBytes: 2 * 1024,
  branchTextChars: 200,
  maxBranchRules: 8,
  /** The final rendered, dispatched payload (wrappers, quoting, consumed results included), UTF-8 bytes. */
  payloadBytes: 32 * 1024,
  definitionBytes: 256 * 1024,
  maxDefinitions: 200,
  maxVersionsPerDefinition: 20,
  maxRetries: 2,
  /** Logical attempts per node = retries + 1. */
  maxAttemptsPerNode: 3,
  /** Σ over agent nodes of (retries + 1); the executor's own step limit. */
  maxSteps: 30,
  maxRemapsPerNode: 2,
  /** Stored sanitized output per attempt (the verdict is parsed from the complete reply before this cut). */
  outputBytes: 32 * 1024,
  verdictReasonChars: 500,
  /** Control history kept per run; older records fold into counters (journaled transitions are kept). */
  controlHistoryRecords: 200,
  /** Per run, kept free for Stop and obligation evidence. */
  protectedBytes: 64 * 1024,
  /** Consecutive refused dispatch generations after which a node waits as "Hermes unavailable". */
  refusedPause: 5,
  /** Timer for that wait, in minutes (a readiness change wakes it sooner). */
  refusedRetryMinutes: 10,
  /** Refused generations of one attempt after which only the person can continue (v8.3). */
  refusedLifetime: 20,
  /** Planner commands per pass are bounded by the node count. */
  commandsPerPass: 30,
} as const

/** Per-run gate policy of a workflow: `gates-only` is the default; `every-step` adds §14's assignment gate per agent node. */
export const WorkflowGatePolicySchema = z.enum(['gates-only', 'every-step'])
export type WorkflowGatePolicy = z.infer<typeof WorkflowGatePolicySchema>

export const WORKFLOW_EXPORT_FORMAT = 'score.workflow/1'

// ---------------------------------------------------------------------------------------------------------------
// Definitions

export const NodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'node ids are lower-case, ≤ 32 characters')
export const PortSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
export const InputNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)

const label = z.string().min(1).max(WORKFLOW_LIMITS.labelChars)
const text = (maxBytes: number) =>
  z
    .string()
    .refine((v) => utf8Bytes(v) <= maxBytes, `limited to ${maxBytes} bytes`)
    .refine(noNul, 'No NUL')

export const WorkflowInputSchema = z
  .object({
    name: InputNameSchema,
    label: z.string().min(1).max(WORKFLOW_LIMITS.inputLabelChars),
    required: z.boolean(),
    maxChars: z.int().min(1).max(WORKFLOW_LIMITS.inputMaxChars),
  })
  .strict()
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>

/**
 * Agent step. `instruction` is a template: `{{inputs.<name>}}` and `{{nodes.<id>.output}}` / `{{nodes.<id>.verdict}}`, with
 * an optional `|default:"…"`. Plain substitution, no expressions. A failure either has a `failed` edge (`route`) or fails
 * the run (`fail_run`); a missing choice is a validation error, never an implicit default.
 */
export const AgentNodeSchema = z
  .object({
    id: NodeIdSchema,
    kind: z.literal('agent'),
    label,
    agentId: AgentIdSchema,
    instruction: text(WORKFLOW_LIMITS.instructionBytes).pipe(z.string().min(1)),
    retries: z.int().min(0).max(WORKFLOW_LIMITS.maxRetries),
    /** Per-step reservation (USD); the run default applies when absent. */
    estimateUsd: z.number().positive().max(1000).optional(),
    onFailure: z.enum(['route', 'fail_run']),
  })
  .strict()

export const GateNodeSchema = z
  .object({
    id: NodeIdSchema,
    kind: z.literal('gate'),
    label,
    question: text(WORKFLOW_LIMITS.questionBytes).pipe(z.string().min(1)),
    /** Rejection either follows a `rejected` edge (`route`) or stops the run (`stop_run`, Stop semantics). */
    onReject: z.enum(['route', 'stop_run']),
  })
  .strict()

export const BranchConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verdict'), is: z.enum(['passed', 'changes_requested']) }).strict(),
  z.object({ kind: z.literal('outcome'), is: z.enum(['succeeded', 'failed']) }).strict(),
  /** Case-insensitive match on the stored sanitized output (not the complete reply); advisory, never a gate. */
  z
    .object({
      kind: z.literal('output_contains'),
      text: z.string().min(1).max(WORKFLOW_LIMITS.branchTextChars).refine(noNul),
    })
    .strict(),
])
export type BranchCondition = z.infer<typeof BranchConditionSchema>

export const BranchRuleSchema = z.object({ id: PortSchema, when: BranchConditionSchema }).strict()

/** Routes on the result of an earlier agent node. The first matching rule wins; the `default` port is mandatory. */
export const BranchNodeSchema = z
  .object({
    id: NodeIdSchema,
    kind: z.literal('branch'),
    label,
    subject: NodeIdSchema,
    rules: z.array(BranchRuleSchema).min(1).max(WORKFLOW_LIMITS.maxBranchRules),
  })
  .strict()

export const JoinNodeSchema = z
  .object({ id: NodeIdSchema, kind: z.literal('join'), label, mode: z.literal('all') })
  .strict()

export const EndNodeSchema = z.object({ id: NodeIdSchema, kind: z.literal('end'), label }).strict()

export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  AgentNodeSchema,
  GateNodeSchema,
  BranchNodeSchema,
  JoinNodeSchema,
  EndNodeSchema,
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowNodeKind = WorkflowNode['kind']

/**
 * Ports: agent `ok` | `failed`; gate `ok` (approved) | `rejected`; branch: a rule id or `default`; join `ok`; end none.
 * Several edges may leave one port (fan-out): each target gets its own token.
 */
export const WorkflowEdgeSchema = z
  .object({ id: NodeIdSchema, from: NodeIdSchema, port: PortSchema, to: NodeIdSchema })
  .strict()
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>

/** Shape and limits only; graph rules (DAG, routing, templates, joins) are reported by validation as `ValidationIssue`s. */
export const WorkflowDefinitionSchema = z
  .object({
    name: z.string().min(1).max(WORKFLOW_LIMITS.nameChars),
    description: z.string().max(WORKFLOW_LIMITS.descriptionChars).optional(),
    inputs: z.array(WorkflowInputSchema).max(WORKFLOW_LIMITS.maxInputs),
    nodes: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.maxNodes),
    edges: z.array(WorkflowEdgeSchema).max(WORKFLOW_LIMITS.maxEdges),
  })
  .strict()
  .refine(
    (v) => utf8Bytes(JSON.stringify(v)) <= WORKFLOW_LIMITS.definitionBytes,
    'a definition is limited to 256 KiB',
  )
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

/** Σ (retries + 1) over agent nodes: the number of executor steps the definition can need at most. */
export const maxStepsOf = (definition: Pick<WorkflowDefinition, 'nodes'>): number =>
  definition.nodes.reduce((sum, node) => sum + (node.kind === 'agent' ? node.retries + 1 : 0), 0)

export const ValidationCodeSchema = z.enum([
  'too_many_nodes',
  'too_many_edges',
  'definition_too_large',
  'steps_over_limit',
  'duplicate_node_id',
  'duplicate_edge_id',
  'duplicate_edge',
  'duplicate_input',
  'unknown_node',
  'bad_port',
  'no_root',
  'bad_root_kind',
  'cycle',
  'unreachable_node',
  'no_end',
  'end_has_outgoing',
  'unrouted_failure',
  'unrouted_rejection',
  'failure_edge_with_fail_run',
  'port_unconnected',
  'branch_no_default',
  'branch_duplicate_rule',
  'branch_subject_invalid',
  'branch_condition_unusable',
  'join_needs_inputs',
  'join_deadlock',
  'template_syntax',
  'template_unknown_input',
  'template_unknown_node',
  'template_self_reference',
  'template_forward_reference',
  'template_not_ancestor',
  'template_needs_default',
  'template_field_unavailable',
  'agent_missing',
])
export type ValidationCode = z.infer<typeof ValidationCodeSchema>

export const ValidationIssueSchema = z.object({
  code: ValidationCodeSchema,
  severity: z.enum(['error', 'warning']),
  nodeId: z.string().nullable(),
  edgeId: z.string().nullable(),
  /** The field inside the node (`instruction`, `question`, `rules[1]`, …) when the issue has one. */
  field: z.string().nullable(),
  message: z.string().min(1).max(500),
})
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>

export const ValidationResultSchema = z.object({
  /** True when there is no `error` issue; only valid definitions can be saved or started. */
  ok: z.boolean(),
  issues: z.array(ValidationIssueSchema),
  stats: z.object({
    nodes: z.int().nonnegative(),
    edges: z.int().nonnegative(),
    maxSteps: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
  }),
})
export type ValidationResult = z.infer<typeof ValidationResultSchema>

// ---------------------------------------------------------------------------------------------------------------
// Definition API (`/api/workflows`). Versions are immutable once saved; "editing" saves a new version.

const workflowId = z.string().min(1).max(100)
const version = z.int().positive()

export const WorkflowVersionSummarySchema = z.object({
  version,
  /** SHA-256 over the canonical definition JSON. */
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  /** A run has used this version: it can never change (a new version is the only way to edit). */
  used: z.boolean(),
  bytes: z.int().positive(),
  nodes: z.int().positive(),
  maxSteps: z.int().nonnegative(),
})
export type WorkflowVersionSummary = z.infer<typeof WorkflowVersionSummarySchema>

export const WorkflowSummarySchema = z.object({
  id: workflowId,
  name: z.string(),
  description: z.string().nullable(),
  latestVersion: version,
  versionCount: z.int().positive(),
  used: z.boolean(),
  agentIds: z.array(AgentIdSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Runs that are not finished (a draining run counts), so the list can warn before a delete. */
  activeRuns: z.int().nonnegative(),
})
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>

export const WorkflowListSchema = z.object({
  items: z.array(WorkflowSummarySchema),
  /** Retained versions across all definitions against the global limit (≤ 200 × 20 × 256 KiB). */
  inventory: z.object({
    definitions: z.int().nonnegative(),
    versions: z.int().nonnegative(),
    bytes: z.int().nonnegative(),
    maxDefinitions: z.int().positive(),
    maxVersionsPerDefinition: z.int().positive(),
  }),
})
export type WorkflowList = z.infer<typeof WorkflowListSchema>

export const WorkflowVersionSchema = WorkflowVersionSummarySchema.extend({
  workflowId,
  definition: WorkflowDefinitionSchema,
})
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>

export const WorkflowDetailSchema = WorkflowSummarySchema.extend({
  versions: z.array(WorkflowVersionSummarySchema),
  latest: WorkflowVersionSchema,
})
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>

/** `POST /api/workflows/validate` and the bodies of the two save endpoints. */
export const WorkflowValidateSchema = z.object({ definition: WorkflowDefinitionSchema }).strict()
export type WorkflowValidate = z.infer<typeof WorkflowValidateSchema>

export const WorkflowCreateSchema = z.object({ definition: WorkflowDefinitionSchema }).strict()
export type WorkflowCreate = z.infer<typeof WorkflowCreateSchema>

/** A save is only accepted on top of the version the editor loaded (otherwise `409 conflict`, `details.latestVersion`). */
export const WorkflowVersionCreateSchema = z
  .object({ baseVersion: version, definition: WorkflowDefinitionSchema })
  .strict()
export type WorkflowVersionCreate = z.infer<typeof WorkflowVersionCreateSchema>

/** Export is scrubbed, not "secret-free"; agents travel as descriptors, never as local ids. */
export const PortableAgentSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(200).nullable(),
})

export const PortableNodeSchema = z.discriminatedUnion('kind', [
  AgentNodeSchema.omit({ agentId: true }).extend({ agent: PortableAgentSchema }),
  GateNodeSchema,
  BranchNodeSchema,
  JoinNodeSchema,
  EndNodeSchema,
])

export const WorkflowExportRequestSchema = z
  .object({
    /** Paths the person removed after seeing the diff (`nodes[2].instruction`); the result is revalidated. */
    removePaths: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .strict()
export type WorkflowExportRequest = z.infer<typeof WorkflowExportRequestSchema>

export const WorkflowExportSchema = z.object({
  format: z.literal(WORKFLOW_EXPORT_FORMAT),
  scrubbed: z.literal(true),
  workflowId,
  version,
  portable: z.object({
    name: z.string(),
    description: z.string().optional(),
    inputs: z.array(WorkflowInputSchema),
    nodes: z.array(PortableNodeSchema),
    edges: z.array(WorkflowEdgeSchema),
  }),
  /** Every free-text field `redact()` changed, with the complete before and after. */
  changes: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
  validation: ValidationResultSchema,
})
export type WorkflowExport = z.infer<typeof WorkflowExportSchema>

// ---------------------------------------------------------------------------------------------------------------
// Runs. `id` is the orchestration id: the same id works with the run-control routes below.

export const NodeStateSchema = z.enum([
  'waiting',
  'ready',
  'gate_open',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'unresolved',
])
export type NodeState = z.infer<typeof NodeStateSchema>

/**
 * Why a `ready` node is not running yet. These are conditions that can change; they never produce a stored refusal
 * (the planner re-evaluates with a new generation). `refusal_limit` and `remap` need the person.
 */
export const WaitingForSchema = z.enum([
  'budget',
  'unknown_spend',
  'capacity',
  'agent_capacity',
  'quota',
  'fence',
  'run_hold',
  'agent_hold',
  'agent_unavailable',
  'hermes_unavailable',
  'remap',
  'refusal_limit',
])
export type WaitingFor = z.infer<typeof WaitingForSchema>

export const TokenKindSchema = z.enum(['ok', 'failed', 'rejected', 'skip', 'branch'])
export type TokenKind = z.infer<typeof TokenKindSchema>

export const GraphOutcomeSchema = z.enum(['reached_end', 'failed', 'stopped'])
export type GraphOutcome = z.infer<typeof GraphOutcomeSchema>

export const VerdictRecordSchema = z.object({
  verdict: z.enum(['passed', 'changes_requested']),
  reason: z.string().max(WORKFLOW_LIMITS.verdictReasonChars),
  source: z.literal('runtime'),
  /** True when the stored output was cut; the verdict was parsed from the complete reply before the cut. */
  outputTruncated: z.boolean(),
})
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>

export const NodeRefusalsSchema = z.object({
  /** Refused generations in a row (reset by an accepted send). */
  consecutive: z.int().nonnegative(),
  /** Refused generations of the current attempt, over its lifetime. */
  lifetime: z.int().nonnegative(),
  lastGeneration: z.int().nonnegative(),
  lastState: z.enum(['refused', 'sent']).nullable(),
  /** The next automatic try (`null` when none is scheduled or the person is needed). */
  nextTryAt: z.iso.datetime().nullable(),
})
export type NodeRefusals = z.infer<typeof NodeRefusalsSchema>

export const NodeViewSchema = z.object({
  nodeId: NodeIdSchema,
  kind: z.enum(['agent', 'gate', 'branch', 'join', 'end']),
  state: NodeStateSchema,
  /** Increments on every change of this node; decisions about it carry the value the page showed. */
  revision: z.int().positive(),
  waitingFor: WaitingForSchema.nullable(),
  /** Logical attempts used / allowed (retries + 1), counted across the replacement lineage. */
  attemptsUsed: z.int().nonnegative(),
  attemptsMax: z.int().nonnegative(),
  /** Executor step of the current logical attempt, and every step of the lineage (oldest first). */
  stepId: z.string().nullable(),
  lineage: z.array(z.string()),
  /** Failure reason or why the node is waiting or unresolved, one redacted line. */
  reason: z.string().max(500).nullable(),
  /** Sanitized stored output of the current attempt (agent nodes), ≤ 32 KiB. */
  output: z.string().nullable(),
  outputTruncated: z.boolean(),
  outputRevision: z.int().nonnegative(),
  verdict: VerdictRecordSchema.nullable(),
  /** Open node gate or, under `every-step`, assignment gate of the node. */
  gateId: z.string().nullable(),
  refusals: NodeRefusalsSchema.nullable(),
  /** Remaps of this node so far (≤ 2). */
  remaps: z.int().nonnegative(),
  /** Unresolved with attempts left: the person may Retry. */
  canRetry: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
})
export type NodeView = z.infer<typeof NodeViewSchema>

export const TokenViewSchema = z.object({
  id: z.string().min(1),
  /** An edge id, or `start:<node>` for the token a start node gets when the run begins. */
  edgeId: z.string().min(1).max(80),
  kind: TokenKindSchema,
  /** The producing node, or `__start`. */
  producedBy: z.string().min(1).max(40),
  /** Logical attempt of the producer (0 for local nodes). */
  producedAttempt: z.int().nonnegative(),
  consumedBy: NodeIdSchema.nullable(),
  createdAt: z.iso.datetime(),
})
export type TokenView = z.infer<typeof TokenViewSchema>

/** What a consuming attempt read: frozen when the attempt was created, checked again when it is sent. */
export const ConsumedViewSchema = z.object({
  consumer: NodeIdSchema,
  consumerAttempt: z.int().positive(),
  producer: NodeIdSchema,
  /** 0 when a template default stood in for a producer that never ran (skipped). */
  producerAttempt: z.int().nonnegative(),
  outputRevision: z.int().nonnegative(),
  /** `output` of a succeeded node, `failure` of a routed failure, `default` a template default was used. */
  kind: z.enum(['output', 'failure', 'default']),
  /** False when the producer's result was withdrawn after the fact (recovered-text repair) or its revision moved. */
  eligible: z.boolean(),
})
export type ConsumedView = z.infer<typeof ConsumedViewSchema>

export const NodeGateViewSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('node'),
  nodeId: NodeIdSchema,
  status: z.enum(['open', 'approved', 'rejected', 'withdrawn']),
  /** Frozen when the gate opened: exactly what the person decides on. */
  payload: z.object({
    question: z.string(),
    consumed: z.array(
      z.object({
        nodeId: NodeIdSchema,
        outputRevision: z.int().nonnegative(),
        /** Bounded preview of the consumed output (≤ 4 KiB). */
        output: z.string(),
        truncated: z.boolean(),
      }),
    ),
    nodeRevision: z.int().positive(),
    runRevision: z.int().positive(),
  }),
  payloadHash: z.string(),
  revision: z.int().positive(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
})
export type NodeGateView = z.infer<typeof NodeGateViewSchema>

/** §14's assignment gate (`every-step`) plus the node it belongs to. Its payload is the exact rendered text. */
export const AssignmentGateViewSchema = GateViewSchema.extend({ nodeId: NodeIdSchema })
export type AssignmentGateView = z.infer<typeof AssignmentGateViewSchema>

/** What a remap would do to work that was never sent (provably unsent), shown before the decision. */
export const RemapPlanItemSchema = z.object({
  nodeId: NodeIdSchema,
  /** The retired attempt (`remapped`) and the re-created payload's hash the decision approves. */
  retiresAttemptId: z.string().nullable(),
  payloadHash: z.string(),
  /** Exact new text that will be dispatched (≤ 32 KiB). */
  payload: z.string(),
})
export type RemapPlanItem = z.infer<typeof RemapPlanItemSchema>

export const WorkflowNeedsYouSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gate'),
    gateId: z.string(),
    gateKind: z.enum(['node', 'assignment']),
    nodeId: NodeIdSchema,
  }),
  z.object({ kind: z.literal('budget'), reason: PauseReasonSchema }),
  z.object({ kind: z.literal('paused'), reason: PauseReasonSchema }),
  z.object({ kind: z.literal('unknown'), attemptId: z.string(), nodeId: NodeIdSchema.nullable() }),
  z.object({ kind: z.literal('cancel_fence'), stepId: z.string(), attemptId: z.string() }),
  z.object({ kind: z.literal('fence'), reason: z.string() }),
  /** An administratively abandoned node: Retry (attempts left) or Stop the run. */
  z.object({ kind: z.literal('retry'), nodeId: NodeIdSchema, attemptsLeft: z.int().nonnegative() }),
  z.object({
    kind: z.literal('remap'),
    agentId: AgentIdSchema,
    frozenIncarnation: z.string().min(1),
    currentIncarnation: z.string().min(1),
    nodeIds: z.array(NodeIdSchema),
    /** Empty when `currentIncarnation` is `untracked` (only Stop is possible). */
    plan: z.array(RemapPlanItemSchema),
  }),
  /** v8.3: Hermes refused this step `refusedLifetime` times; Try again or Stop the run. */
  z.object({
    kind: z.literal('refusal_limit'),
    nodeId: NodeIdSchema,
    attemptId: z.string(),
    refusals: z.int().positive(),
  }),
])
export type WorkflowNeedsYou = z.infer<typeof WorkflowNeedsYouSchema>

export const AgentMapEntrySchema = z.object({
  agentId: AgentIdSchema,
  /** Lifecycle incarnation frozen at start (or at the last remap). */
  incarnation: z.string().min(1),
  /** `current` | `changed` (replaced since) | `removed` (`untracked`). */
  status: z.enum(['current', 'changed', 'removed']),
})
export type AgentMapEntry = z.infer<typeof AgentMapEntrySchema>

/** Honest spend (v8.1): live Hermes cannot prove `lineageComplete`, so its spend is never settled. */
export const SpendEvidenceSchema = z.object({
  attemptId: z.string(),
  attributed: z.boolean(),
  lineageComplete: z.boolean(),
  fresh: z.boolean(),
  /** `dollars` = Hermes reported a cost; `tokens` = token counts only; `none` = nothing reported. */
  costScope: z.enum(['dollars', 'tokens', 'none']),
})
export type SpendEvidence = z.infer<typeof SpendEvidenceSchema>

export const StorageInventorySchema = z.object({
  reserveBytes: z.int().nonnegative(),
  storedBytes: z.int().nonnegative(),
  protectedBytes: z.int().nonnegative(),
  /** Everything the run's per-run charge covers; released only when every associated row is deleted. */
  items: z.array(
    z.object({
      kind: z.enum([
        'orchestration_rows',
        'workflow_rows',
        'receipts',
        'intents',
        'room_messages',
        'message_runs',
        'attempt_runs',
        'tool_rows',
        'control_history',
      ]),
      rows: z.int().nonnegative(),
      bytes: z.int().nonnegative(),
    }),
  ),
  /** Control records folded into counters beyond the per-run limit of 200. */
  compactedControlRecords: z.int().nonnegative(),
})
export type StorageInventory = z.infer<typeof StorageInventorySchema>

export const WorkflowRunSummarySchema = z.object({
  /** The orchestration id. */
  id: z.string().min(1),
  title: z.string(),
  workflowId: workflowId,
  workflowName: z.string(),
  version,
  /** The executor's status (§14); `finished_with_unresolved` can accompany `graphOutcome: reached_end`. */
  status: z.enum([
    'running',
    'paused',
    'stopping',
    'finishing',
    'succeeded',
    'finished_with_unresolved',
    'stopped',
    'failed',
  ]),
  pauseReason: PauseReasonSchema.nullable(),
  /** What the graph did, separately from `status`; `null` until the graph is terminal. */
  graphOutcome: GraphOutcomeSchema.nullable(),
  /** One line combining both ("Graph reached the end — 1 abandoned attempt not confirmed ended"). */
  outcomeNote: z.string().max(300).nullable(),
  gatePolicy: WorkflowGatePolicySchema,
  roomId: z.string().min(1),
  briefId: z.string().min(1),
  revision: z.int().positive(),
  ownership: OwnershipStateSchema,
  nodes: z.object({
    total: z.int().nonnegative(),
    waiting: z.int().nonnegative(),
    ready: z.int().nonnegative(),
    running: z.int().nonnegative(),
    gateOpen: z.int().nonnegative(),
    succeeded: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
    unresolved: z.int().nonnegative(),
  }),
  needsYou: z.array(WorkflowNeedsYouSchema),
  /** Attempts abandoned or unknown whose end is not confirmed. */
  unconfirmed: z.int().nonnegative(),
  rerunOf: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
})
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>

export const WorkflowRunListSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  items: z.array(WorkflowRunSummarySchema),
})
export type WorkflowRunList = z.infer<typeof WorkflowRunListSchema>

export const WorkflowRunDetailSchema = WorkflowRunSummarySchema.extend({
  /** The frozen definition the run executes (the version, as saved). */
  definition: WorkflowDefinitionSchema,
  /** Frozen start inputs (≤ 16 KiB). */
  inputs: z.record(z.string(), z.string()),
  agentMap: z.array(AgentMapEntrySchema),
  /** The planner's generation: increments whenever the graph's admission conditions are re-evaluated. */
  plannerGeneration: z.int().nonnegative(),
  nodeStates: z.array(NodeViewSchema),
  tokens: z.array(TokenViewSchema),
  consumed: z.array(ConsumedViewSchema),
  nodeGates: z.array(NodeGateViewSchema),
  assignmentGates: z.array(AssignmentGateViewSchema),
  steps: z.array(StepViewSchema),
  attempts: z.array(AttemptViewSchema),
  deadlineAt: z.iso.datetime().nullable(),
  maxSteps: z.int().positive(),
  maxConcurrentSteps: z.int().positive(),
  stepEstimateUsd: z.number(),
  budget: BudgetViewSchema,
  /** `pause` (default) stops a budgeted run when spend is unknown; `continue` was chosen at start. */
  unknownSpend: z.enum(['pause', 'continue']),
  spend: z.object({
    /** Always false for live Hermes today: "spend not settled — Hermes doesn't report complete costs". */
    settled: z.boolean(),
    note: z.string(),
    evidence: z.array(SpendEvidenceSchema),
  }),
  cancelFence: z.array(z.object({ stepId: z.string(), attemptId: z.string() })),
  waiverAt: z.iso.datetime().nullable(),
  acknowledgedAt: z.iso.datetime(),
  endReason: z.string().nullable(),
  storage: StorageInventorySchema,
})
export type WorkflowRunDetail = z.infer<typeof WorkflowRunDetailSchema>

/** **S**: `asOfSeq` is read in the same transaction as the data. */
export const WorkflowRunSnapshotSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  run: WorkflowRunDetailSchema,
})
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>

export const WorkflowEventKindSchema = z.enum([
  ...OrchEventKindSchema.options,
  /** A node became ready / changed state; the planner's own moves. */
  'node_state',
  'token',
  'planner',
  'graph_end',
])
export type WorkflowEventKind = z.infer<typeof WorkflowEventKindSchema>

export const WorkflowEventSchema = OrchEventSchema.omit({ kind: true }).extend({
  kind: WorkflowEventKindSchema,
  nodeId: NodeIdSchema.nullable(),
})
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>

export const WorkflowRunEventsSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  events: z.array(WorkflowEventSchema),
})
export type WorkflowRunEvents = z.infer<typeof WorkflowRunEventsSchema>

// ---------------------------------------------------------------------------------------------------------------
// Start

export const WorkflowPreflightCheckSchema = PreflightCheckSchema.extend({
  id: z.enum(['definition', 'agents', 'mapping', 'global_fence', 'journal', 'capacity', 'quota']),
})

export const WorkflowPreflightSchema = z.object({
  ok: z.boolean(),
  checks: z.array(WorkflowPreflightCheckSchema),
  /** Agents the definition uses with their current incarnation: the start request must name exactly these. */
  mapping: z.array(
    z.object({ agentId: AgentIdSchema, name: z.string(), incarnation: z.string().min(1) }),
  ),
  gatePolicyNotes: z.object({ 'gates-only': z.string(), 'every-step': z.string() }),
  acknowledgementText: z.literal(ORCH_ACKNOWLEDGEMENT_TEXT),
  spendNote: z.string(),
  maxSteps: z.int().nonnegative(),
  reserveBytes: z.int().nonnegative(),
  defaults: z.object({
    gatePolicy: WorkflowGatePolicySchema,
    maxConcurrentSteps: z.int(),
    stepEstimateUsd: z.number(),
  }),
})
export type WorkflowPreflight = z.infer<typeof WorkflowPreflightSchema>

export const WorkflowRunCreateSchema = z
  .object({
    workflowId,
    version,
    /** Values for the definition's inputs; unknown names, over-long values and missing required inputs are refused. */
    inputs: z.record(InputNameSchema, text(WORKFLOW_LIMITS.inputMaxChars * 4)),
    /** The incarnations the page showed; a different current incarnation is `409 conflict`. */
    agentMap: z
      .array(z.object({ agentId: AgentIdSchema, incarnation: z.string().min(1) }).strict())
      .max(30),
    gatePolicy: WorkflowGatePolicySchema.default('gates-only'),
    budgetUsd: z.number().positive().max(10_000).optional(),
    deadlineAt: z.iso.datetime().optional(),
    unknownSpend: z.enum(['pause', 'continue']).default('pause'),
    maxConcurrentSteps: z.int().min(1).max(3).default(2),
    stepEstimateUsd: z.number().positive().max(1000).default(0.5),
    rerunOf: z.string().min(1).max(100).optional(),
    /** Must be exactly `ORCH_ACKNOWLEDGEMENT_TEXT`; recorded on the run. */
    acknowledgement: z.object({ text: z.literal(ORCH_ACKNOWLEDGEMENT_TEXT) }),
  })
  .strict()
  .refine(
    (v) => utf8Bytes(JSON.stringify(v.inputs)) <= WORKFLOW_LIMITS.startInputsBytes,
    'start inputs are limited to 16 KiB',
  )
export type WorkflowRunCreate = z.infer<typeof WorkflowRunCreateSchema>

export const WorkflowRunCreatedSchema = z.object({
  run: WorkflowRunSummarySchema,
  preflight: WorkflowPreflightSchema,
})
export type WorkflowRunCreated = z.infer<typeof WorkflowRunCreatedSchema>

// ---------------------------------------------------------------------------------------------------------------
// Decisions. Every one is paired (H), carries `orchestrationRevision` (the run's `revision` the page showed; stale →
// `409 conflict`, `details.currentRevision`) and, where it names a node or gate, that object's own revision.

const revision = z.int().positive()

/** `POST /api/workflow-runs/:id/gates/:gateId/decision`: approve → `ok` token; reject → `rejected` token or stop. */
export type WorkflowGateDecision = GateDecision

/** `POST /api/workflow-runs/:id/nodes/:nodeId/retry`: only for an `unresolved` node with attempts left. */
export const WorkflowRetryDecisionSchema = z
  .object({
    expectedNodeRevision: revision,
    orchestrationRevision: revision,
    /** "The abandoned attempt may still be running; Score keeps trying to stop it and ignores its late result." */
    acknowledge: z.literal(true),
  })
  .strict()
export type WorkflowRetryDecision = z.infer<typeof WorkflowRetryDecisionSchema>

/** `POST /api/workflow-runs/:id/nodes/:nodeId/try-again`: continue after `refusedLifetime` refused generations. */
export const WorkflowTryAgainDecisionSchema = z
  .object({ expectedNodeRevision: revision, orchestrationRevision: revision })
  .strict()
export type WorkflowTryAgainDecision = z.infer<typeof WorkflowTryAgainDecisionSchema>

/** `POST /api/workflow-runs/:id/remap`: §14's decision plus the exact re-created payloads the card showed. */
export const WorkflowRemapDecisionSchema = z
  .object({
    agentId: AgentIdSchema,
    frozenIncarnation: z.string().min(1),
    currentIncarnation: z.string().min(1),
    orchestrationRevision: revision,
    acknowledge: z.literal(true),
    plan: z
      .array(z.object({ nodeId: NodeIdSchema, payloadHash: z.string().min(1) }).strict())
      .max(30),
  })
  .strict()
export type WorkflowRemapDecision = z.infer<typeof WorkflowRemapDecisionSchema>

// Run controls reuse §14's bodies verbatim: pause / resume / stop `RunControlSchema`, limits `LimitsDecisionSchema`, waiver
// `WaiverDecisionSchema`, abandon `AbandonDecisionSchema`.

// ---------------------------------------------------------------------------------------------------------------
// Planner principal. Server-only (no capability, no MCP). Its commands have deterministic, run-scoped identities, so a
// crash before or after a pass re-derives the same command and a stored identity returns its receipt.

export const PlannerVerbSchema = z.enum(['assign', 'cancel', 'finish'])
export type PlannerVerb = z.infer<typeof PlannerVerbSchema>

export interface PlannerCommandIdentity {
  run: string
  node: string
  /** Logical attempt (1-based; 0 for run-level verbs such as finish). */
  attempt: number
  verb: PlannerVerb
  /** Re-evaluation generation: increments when a waiting node is evaluated again after a wake cause. */
  generation: number
}

export const plannerCommandId = (c: PlannerCommandIdentity): string =>
  `wf:${c.run}:${c.node}:${c.attempt}:${c.verb}:${c.generation}`

/** Receipt kept in `wf_commands` for every planner command. */
export const PlannerReceiptSchema = z.object({
  status: z.enum(['ok', 'refused']),
  /** Permanent refusals fail the node (`validation`, `mapping_mismatch`, `payload_too_large`, …). */
  code: z.string().optional(),
  message: z.string().max(500).optional(),
  stepId: z.string().optional(),
})
export type PlannerReceipt = z.infer<typeof PlannerReceiptSchema>

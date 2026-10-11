import { z } from 'zod'
import { AutoSummarySchema, RoomImportSchema } from './conversations.ts'

export const AgentIdSchema = z.string().min(1)
export type AgentId = z.infer<typeof AgentIdSchema>

export const ShapeSchema = z.enum([
  'circle-dot',
  'triangle',
  'diamond',
  'square',
  'hexagon',
  'star',
  'pill',
  'cross',
])
export type Shape = z.infer<typeof ShapeSchema>

export const AgentStyleSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  shape: ShapeSchema,
})
export type AgentStyle = z.infer<typeof AgentStyleSchema>

export const AgentStatusSchema = z.enum([
  'idle',
  'working',
  'waiting',
  'paused',
  'offline',
  'up-next',
])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

/** Which engine runs an agent's turns: a Hermes profile or a coding-agent CLI (PLAN 7.2). Absent = `hermes`. */
export const RuntimeSchema = z.enum(['hermes', 'claude-code', 'codex', 'antigravity', 'opencode'])
export type Runtime = z.infer<typeof RuntimeSchema>
/** Where a run's cost came from: the CLI/provider reported it, it is an API-price equivalent, or nothing says. */
export const CostKindSchema = z.enum(['reported', 'estimated', 'unknown'])
export type CostKind = z.infer<typeof CostKindSchema>

export const AgentSummarySchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  role: z.string(),
  style: AgentStyleSchema,
  status: AgentStatusSchema,
  activity: z.string().nullable(),
  model: z.object({ id: z.string().min(1), label: z.string() }).nullable(),
  served: z.boolean(),
  /** Absent = a Hermes profile. Coding agents (PLAN 7.2) carry their CLI here. */
  runtime: RuntimeSchema.optional(),
  /** Coding agents: one line for the agent card, e.g. "Claude Code · uses your Claude plan quota". */
  runtimeNote: z.string().optional(),
  lifecycle: z
    .object({
      state: z.enum(['setting_up', 'ready', 'deleting', 'needs_attention', 'removed']),
      incarnationId: z.uuid(),
      operationId: z.uuid().nullable(),
    })
    .optional(),
})
export type AgentSummary = z.infer<typeof AgentSummarySchema>

export const RoutineSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  schedule: z.string(),
  description: z.string(),
  lastRunAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
})
export type RoutineSummary = z.infer<typeof RoutineSummarySchema>

export const AgentDetailSchema = AgentSummarySchema.extend({
  tagline: z.string(),
  personality: z.object({ excerpt: z.string(), source: z.literal('SOUL.md') }),
  reportsTo: AgentIdSchema.nullable(),
  worksIn: z.string().nullable(),
  rulesFile: z.literal('AGENTS.md').nullable(),
  // Null when the model can't be read (unlike the summary, the detail adds where it comes from).
  model: z
    .object({
      id: z.string().min(1),
      label: z.string(),
      via: z.string(),
      fallback: z.string().nullable(),
    })
    .nullable(),
  skills: z.array(z.object({ name: z.string().min(1), enabled: z.boolean() })),
  memory: z.array(
    z.object({ id: z.string().min(1), text: z.string(), source: z.string(), at: z.iso.datetime() }),
  ),
  tools: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string(),
      kind: z.enum(['builtin', 'mcp']),
      enabled: z.boolean(),
    }),
  ),
  helpersMax: z.int().nonnegative().nullable(),
  routines: z.array(RoutineSummarySchema),
  channels: z.array(z.object({ platform: z.string(), label: z.string(), connected: z.boolean() })),
  permissions: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string(),
      level: z.enum(['allowed', 'asks', 'never']),
      inherited: z.boolean(),
    }),
  ),
})
export type AgentDetail = z.infer<typeof AgentDetailSchema>

export const RefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room'), roomId: z.string().min(1) }),
  z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
  z.object({ kind: z.literal('run'), runId: z.string().min(1) }),
  z.object({ kind: z.literal('brief'), briefId: z.string().min(1) }),
])
export type Ref = z.infer<typeof RefSchema>

export const ApprovalChoiceSchema = z.enum(['once', 'session', 'always', 'deny'])
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  origin: z.enum(['score-run', 'gateway', 'kanban']),
  phase: z.enum([
    'guardian_evaluating',
    'escalated',
    'human_pending',
    'decided',
    'executed',
    'blocked',
    'withdrawn',
    'expired',
  ]),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'withdrawn', 'unknown']),
  actionable: z.boolean(),
  linkedTo: z.string().min(1).nullable(),
  agentId: AgentIdSchema,
  title: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  description: z.string(),
  choices: z.array(ApprovalChoiceSchema),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  decision: z
    .object({
      choice: ApprovalChoiceSchema,
      by: z.enum(['you', 'guardian', 'elsewhere', 'timeout', 'rule']),
      at: z.iso.datetime(),
    })
    .nullable(),
  delivery: z.enum(['none', 'intent', 'delivering', 'applied', 'not_pending', 'failed', 'unknown']),
  blocking: z.string().nullable(),
  refs: z.array(RefSchema),
})
export type Approval = z.infer<typeof ApprovalSchema>

export const TaskColumnSchema = z.enum(['planned', 'working', 'in_review', 'needs_you', 'done'])
export type TaskColumn = z.infer<typeof TaskColumnSchema>

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  title: z.string(),
  column: TaskColumnSchema,
  hermesStatus: z.string(),
  assignee: AgentIdSchema.nullable(),
  reviewer: AgentIdSchema.nullable(),
  roomId: z.string().min(1).nullable(),
  badge: z
    .object({
      kind: z.enum(['changes_requested', 'starts_after', 'blocked', 'needs_you', 'triage']),
      label: z.string(),
    })
    .nullable(),
  progress: z.number().min(0).max(1).nullable(),
  elapsedSec: z.int().nonnegative().nullable(),
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

export const TaskStepSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  done: z.boolean(),
})
export type TaskStep = z.infer<typeof TaskStepSchema>

export const TaskActivitySchema = z.object({
  at: z.iso.datetime(),
  agentId: AgentIdSchema.nullable(),
  text: z.string(),
})
export type TaskActivity = z.infer<typeof TaskActivitySchema>

export const TaskDetailSchema = TaskSummarySchema.extend({
  body: z.string(),
  createdBy: z.string(),
  steps: z.array(TaskStepSchema),
  activity: z.array(TaskActivitySchema),
  pendingApproval: ApprovalSchema.nullable(),
  dependsOn: z.array(z.string().min(1)),
  blocks: z.array(z.string().min(1)),
  runIds: z.array(z.string().min(1)),
  /** Kanban's own completion time; absent on older projections and in the fake adapter. */
  completedAt: z.iso.datetime().nullable().optional(),
  /** The newest brief Score linked this task to; Flow opens that run. Absent when none (or unknown). */
  briefId: z.string().min(1).nullable().optional(),
  /**
   * Legacy numeric run links that Kanban attempts could not map back to an attempt (5.17a-1, only with attempts
   * enabled): `legacyId` is the old id, `reason` says why it stayed unresolved. Absent when attempts are off.
   */
  unresolvedRunLinks: z
    .array(z.object({ legacyId: z.string().min(1), reason: z.string() }))
    .optional(),
})
export type TaskDetail = z.infer<typeof TaskDetailSchema>

export const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['room', 'direct']),
  leadAgentId: AgentIdSchema.nullable(),
  members: z.array(AgentIdSchema),
  unread: z.int().nonnegative(),
  activeAgents: z.array(AgentIdSchema),
  channels: z.array(z.object({ platform: z.string(), label: z.string() })),
  /** Organising (PLAN 5.26), Score-side only; the server always sends them, older fixtures and events may omit them. Pinned rooms list first; archived ones sit behind "Show archived". */
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  projectId: z.string().min(1).nullable().optional(),
  /** Explicit tags, else the `#tag` words after the first word of the name. */
  tags: z.array(z.string()).optional(),
  /** Set on a room made from a Hermes session that Score did not start. */
  importedFrom: RoomImportSchema.nullable().optional(),
  /** Opt-in summary of long history (PLAN 7.4a); the server always sends it, absent = off. */
  autoSummary: AutoSummarySchema.optional(),
})
export type Room = z.infer<typeof RoomSchema>

export const LaneBlockSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  state: z.enum(['done', 'working', 'planned', 'waiting']),
  start: z.iso.datetime(),
  end: z.iso.datetime().nullable(),
  taskId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  /**
   * task = a Kanban task or other exact run; brief = work of a brief with tasks or a plan; chat = plain chat replies of
   * one agent, merged into one band when less than 5 minutes apart. Older stored plan blocks have none: a task.
   */
  kind: z.enum(['task', 'brief', 'chat']).default('task'),
  /** Chat bands only: how many replies the band covers. */
  count: z.int().min(1).optional(),
  /** Kanban attempt blocks only (5.17a-1): the attempt behind the block (`runId` is null for them). */
  attemptId: z.string().regex(/^kr_/).optional(),
  /**
   * Kanban attempt blocks only: Score stopped observing the attempt here; the block ends at this time with a
   * "no longer observed" tail and nothing after it is counted.
   */
  observationEndedAt: z.iso.datetime().nullable().optional(),
  /** Kanban attempt blocks only: `partial` = claim provenance could not be proven. */
  provenance: z.enum(['proven', 'partial']).optional(),
  /** Kanban attempt blocks only: sort key `[startedAt, upstream attempt id]`. Clients sort by it, never by `id`. */
  order: z.tuple([z.iso.datetime(), z.int().nonnegative()]).optional(),
})
export type LaneBlock = z.infer<typeof LaneBlockSchema>

export const MessagePartSchema = z.discriminatedUnion('kind', [
  // `via: 'mcp'` marks a message an agent posted through Score's MCP server (PLAN 7.4d); the UI shows a "via MCP" tag.
  z.object({ kind: z.literal('text'), text: z.string(), via: z.literal('mcp').optional() }),
  z.object({
    kind: z.literal('plan'),
    lanes: z.array(z.object({ agentId: AgentIdSchema, blocks: z.array(LaneBlockSchema) })),
    briefId: z.string().min(1),
  }),
  z.object({ kind: z.literal('tools'), summary: z.string(), runId: z.string().min(1) }),
  // One tool call of a run (PLAN 5.25). `args` and `result` are redacted previews, bounded by the server.
  z.object({
    kind: z.literal('tool'),
    tool: z.string().min(1).max(200),
    args: z.string().max(2048),
    result: z.string().max(2048).nullable(),
    status: z.enum(['running', 'ok', 'error']),
  }),
  // The model's reasoning text, redacted and bounded; shown collapsed.
  z.object({ kind: z.literal('thinking'), text: z.string().max(8192) }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    added: z.int().nonnegative(),
    removed: z.int().nonnegative(),
  }),
  // An uploaded image (`/api/media/:mediaId`) attached to a human message.
  z.object({ kind: z.literal('image'), mediaId: z.string().min(1) }),
  // An uploaded document (PLAN 5.30; `kind: 'file'` already means a changed file): PDF, DOCX, XLSX or text.
  z.object({
    kind: z.literal('document'),
    mediaId: z.string().min(1),
    name: z.string().min(1).max(200),
    contentType: z.string().min(1).max(128),
    size: z.int().positive(),
    /** Where a PDF/DOCX/XLSX was saved in each addressed agent's workspace. */
    saved: z.array(z.object({ agentId: AgentIdSchema, path: z.string().min(1) })).optional(),
  }),
  // A reference to a file in an agent's workspace (`workspace://<path>`); the bytes are not copied.
  z.object({
    kind: z.literal('workspace'),
    agentId: AgentIdSchema,
    path: z.string().min(1).max(4096),
  }),
  z.object({ kind: z.literal('approval'), approvalId: z.string().min(1) }),
  z.object({
    kind: z.literal('review'),
    verdict: z.enum(['approved', 'changes_requested']),
    taskId: z.string().min(1).nullable(),
  }),
  // A summary of the room's earlier messages (PLAN 7.4a). Text only; the message's author is the agent that wrote it.
  z.object({
    kind: z.literal('summary'),
    /** The newest message the summary covers. */
    coversUntil: z.string().min(1),
    text: z.string().max(16384),
    /** A covered message was rewound, edited or deleted: not used as context until regenerated or edited. */
    stale: z.boolean().optional(),
    /** The person rewrote it. */
    edited: z.boolean().optional(),
  }),
])
export type MessagePart = z.infer<typeof MessagePartSchema>

export const MessageSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('you') }),
    z.object({ kind: z.literal('agent'), agentId: AgentIdSchema }),
  ]),
  to: z.array(AgentIdSchema),
  parts: z.array(MessagePartSchema),
  createdAt: z.iso.datetime(),
  streaming: z.boolean(),
  refs: z.array(RefSchema),
  /** Streaming agent replies: when the run last did anything (text, tool, reasoning, approval). Absent = since `createdAt`. */
  progressAt: z.iso.datetime().nullish(),
  /** Set on the original when a later message of the same sender corrected it (edit and resend). */
  editedBy: z.string().min(1).nullish(),
  /** Set on the corrected message: the id of the message it replaces. */
  edits: z.string().min(1).nullish(),
})
export type Message = z.infer<typeof MessageSchema>

export const RunSummarySchema = z.object({
  id: z.string().min(1),
  agentId: AgentIdSchema,
  origin: z.enum(['score', 'kanban', 'gateway', 'cron']),
  status: z.enum([
    'queued',
    'running',
    'waiting_for_approval',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  model: z.string().nullable(),
  toolsUsed: z.array(z.string()),
  tokens: z.object({ input: z.int().nonnegative(), output: z.int().nonnegative() }).nullable(),
  costUsd: z.number().nonnegative().nullable(),
  /** Absent = `hermes`. */
  runtime: RuntimeSchema.optional(),
  /** How to read `costUsd`; absent = `reported`. A coding CLI that gives no cost says `unknown` with `costUsd: null`. */
  costKind: CostKindSchema.optional(),
  refs: z.array(RefSchema),
  gaps: z.array(
    z.object({ from: z.iso.datetime(), to: z.iso.datetime().nullable(), reason: z.string() }),
  ),
})
export type RunSummary = z.infer<typeof RunSummarySchema>

export const HandoffSchema = z.object({
  id: z.string().min(1),
  /** `agentId: null` = the Unattributed lane (a Kanban attempt whose claiming profile is unknown). */
  from: z.object({ agentId: AgentIdSchema.nullable(), blockId: z.string().min(1) }),
  to: z.object({ agentId: AgentIdSchema.nullable(), blockId: z.string().min(1) }),
  kind: z.enum(['handoff', 'review', 'sent_back']),
  at: z.iso.datetime(),
})
export type Handoff = z.infer<typeof HandoffSchema>

export const SystemStatusSchema = z.object({
  mode: z.enum(['live', 'fake']),
  hermes: z.object({
    version: z.string().nullable(),
    reachable: z.boolean(),
    apiServer: z.boolean(),
    capabilities: z.array(z.string()),
    servedProfiles: z.array(AgentIdSchema),
  }),
  bridge: z.object({
    producers: z.int().nonnegative(),
    lastSeenAt: z.iso.datetime().nullable(),
    isolation: z.enum(['in_process', 'host', 'unknown']),
  }),
  compatibility: z.object({
    fingerprint: z.string(),
    tested: z.boolean(),
    disabled: z.array(z.string()),
  }),
  agentIsolation: z.enum(['same_user', 'sandboxed', 'unknown']),
  degraded: z.array(z.string()),
})
export type SystemStatus = z.infer<typeof SystemStatusSchema>

export const LogLineSchema = z.object({
  id: z.string().min(1),
  at: z.iso.datetime(),
  agentId: AgentIdSchema,
  kind: z.enum(['tool', 'message', 'handoff', 'approval', 'system']),
  text: z.string(),
})
export type LogLine = z.infer<typeof LogLineSchema>

export const WatchFrameSchema = z
  .object({
    seq: z.int().positive(),
    at: z.iso.datetime(),
    agentId: AgentIdSchema,
    runId: z.string().min(1).nullable(),
    surface: z.enum(['terminal', 'editor', 'browser']),
    terminal: z
      .object({
        cwd: z.string(),
        command: z.string(),
        output: z.string().refine((output) => {
          // The contract caps UTF-8 bytes, including multibyte text, rather than JS code units.
          return new TextEncoder().encode(output).length <= 65536
        }, 'Terminal output must be at most 64 KB'),
        status: z.enum(['running', 'ok', 'error', 'paused']),
      })
      .optional(),
    editor: z
      .object({ path: z.string(), diff: z.string(), language: z.string().nullable() })
      .optional(),
    browser: z
      .object({ url: z.string(), title: z.string().nullable(), imageUrl: z.string().nullable() })
      .optional(),
    caption: z.string(),
  })
  .refine((frame) => frame[frame.surface] !== undefined, {
    message: 'The payload for the selected surface is required',
    path: ['surface'],
  })
export type WatchFrame = z.infer<typeof WatchFrameSchema>

// Kanban attempts (PLAN 5.17a-1, behind SCORE_KANBAN_ATTEMPTS). A worker attempt is Score's own record of one
// claim-to-close stretch of a Kanban task. It is not a `RunSummary`: tools, session and model are not observed.

/** A task qualified by the lineage of the board it came from. Only `current: true` refs may navigate or act. */
export const TaskRefSchema = z.object({
  taskId: z.string().min(1),
  historyId: z.string().min(1),
  current: z.boolean(),
})
export type TaskRef = z.infer<typeof TaskRefSchema>

export const AttemptStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'blocked',
  'review_handoff',
  'changes_requested',
  'ended_unknown',
])
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>

export const AttemptSummarySchema = z.object({
  /** Opaque (`kr_<uuid>`): never parsed, never sorted by. */
  id: z.string().regex(/^kr_/),
  kind: z.literal('kanban'),
  /** The frozen claim profile; null = unknown (never the task's current assignee). */
  agentId: AgentIdSchema.nullable(),
  role: z.enum(['implementer', 'reviewer']).nullable(),
  status: AttemptStatusSchema,
  closureReason: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** Set when observation stopped before the attempt ended; never an end time. */
  observationEndedAt: z.iso.datetime().nullable(),
  /** `partial` = the claim could not be proven (provenance unknown). */
  evidence: z.enum(['proven', 'partial']),
  /** Same as `task.taskId`. */
  taskId: z.string().min(1),
  task: TaskRefSchema,
  /** `[startedAt, upstream attempt id]`: the only valid sort key. */
  order: z.tuple([z.iso.datetime(), z.int().nonnegative()]),
  /** Observations of this attempt that were refused as contradictions (terminal -> open and similar). */
  refusedUpdates: z.int().nonnegative(),
  /** Always null: null = not observed (never `[]`). */
  tools: z.null(),
  session: z.null(),
  model: z.null(),
})
export type AttemptSummary = z.infer<typeof AttemptSummarySchema>

/** `GET /api/attempts/:id`: the summary plus what the task looked like when Score last observed the attempt. */
export const AttemptDetailSchema = AttemptSummarySchema.extend({
  taskSnapshot: z
    .object({ title: z.string().max(300), status: z.string(), assignee: z.string().nullable() })
    .nullable(),
})
export type AttemptDetail = z.infer<typeof AttemptDetailSchema>

/** What a time-ordered list of work holds: gateway/Score runs and Kanban attempts. */
export const WorkItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), run: RunSummarySchema }),
  z.object({ kind: z.literal('attempt'), attempt: AttemptSummarySchema }),
])
export type WorkItem = z.infer<typeof WorkItemSchema>

import { z } from 'zod'

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

export const AgentSummarySchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  role: z.string(),
  style: AgentStyleSchema,
  status: AgentStatusSchema,
  activity: z.string().nullable(),
  model: z.object({ id: z.string().min(1), label: z.string() }).nullable(),
  served: z.boolean(),
})
export type AgentSummary = z.infer<typeof AgentSummarySchema>

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
    'human_pending',
    'decided',
    'executed',
    'blocked',
    'withdrawn',
    'expired',
  ]),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'withdrawn', 'unknown']),
  actionable: z.boolean(),
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
})
export type LaneBlock = z.infer<typeof LaneBlockSchema>

export const MessagePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('plan'),
    lanes: z.array(z.object({ agentId: AgentIdSchema, blocks: z.array(LaneBlockSchema) })),
    briefId: z.string().min(1),
  }),
  z.object({ kind: z.literal('tools'), summary: z.string(), runId: z.string().min(1) }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    added: z.int().nonnegative(),
    removed: z.int().nonnegative(),
  }),
  z.object({ kind: z.literal('approval'), approvalId: z.string().min(1) }),
  z.object({
    kind: z.literal('review'),
    verdict: z.enum(['approved', 'changes_requested']),
    taskId: z.string().min(1).nullable(),
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
  refs: z.array(RefSchema),
  gaps: z.array(
    z.object({ from: z.iso.datetime(), to: z.iso.datetime().nullable(), reason: z.string() }),
  ),
})
export type RunSummary = z.infer<typeof RunSummarySchema>

export const HandoffSchema = z.object({
  id: z.string().min(1),
  from: z.object({ agentId: AgentIdSchema, blockId: z.string().min(1) }),
  to: z.object({ agentId: AgentIdSchema, blockId: z.string().min(1) }),
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

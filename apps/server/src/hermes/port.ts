import {
  ApprovalChoiceSchema,
  ApprovalSchema,
  type AgentSummary,
  type SystemStatus,
  AgentIdSchema,
  TaskColumnSchema,
  TaskStepSchema,
  type RoutineSummary,
  type TaskDetail,
  type TaskSummary,
} from '@score/contract'
import { z } from 'zod'
import type {
  AgentDetail,
  ConnectResult,
  ConnectionsResponse,
  LocalProviderRequest,
  ProviderItem,
  ToolServerRequest,
} from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { AgentFile, AgentFileName } from './agent-files.ts'
import type { AgentTool, HubSkill, MemoryItem, MemoryPage, SkillItem } from './agent-tabs.ts'
import type { ApprovalConfig } from './approvals.ts'
import type { IngestResult, Observation } from '../hub/ingest.ts'

export interface ObservationSink {
  submit(obs: Observation): Promise<IngestResult>
}

export const DecisionDeliveryRequestSchema = z.object({
  approvalId: z.string().min(1),
  origin: ApprovalSchema.shape.origin,
  profile: z.string().min(1),
  runId: z.string().min(1).nullable(),
  requestId: z.string().min(1),
  choice: ApprovalChoiceSchema,
})

export const TaskActionRequestSchema = z
  .object({
    taskId: z.string().min(1).max(256),
    action: z.enum([
      'start',
      'block',
      'unblock',
      'request_review',
      'request_changes',
      'complete',
      'archive',
      'comment',
    ]),
    text: z
      .string()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .refine((req) => req.action !== 'comment' || Boolean(req.text?.trim()))

const InputTextSchema = z.string().refine((value) => !value.includes('\0'))
const StepTextSchema = InputTextSchema.refine((value) => !/[\r\n]/.test(value))
export const CreateTaskSchema = z
  .object({
    title: InputTextSchema.min(1).max(1000),
    body: InputTextSchema.max(32000).optional(),
    assignee: AgentIdSchema.optional(),
    reviewer: AgentIdSchema.optional(),
    roomId: z.string().min(1).optional(),
    dependsOn: z.array(z.string().min(1).max(256)).max(100).optional(),
    steps: z.array(StepTextSchema.max(2000)).max(100).optional(),
  })
  .strict()
export const PatchTaskSchema = z
  .object({
    title: CreateTaskSchema.shape.title.optional(),
    body: CreateTaskSchema.shape.body,
    assignee: AgentIdSchema.optional(),
    reviewer: AgentIdSchema.optional(),
    steps: z
      .array(TaskStepSchema.extend({ text: StepTextSchema.max(2000) }))
      .max(100)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
const RoutineTextSchema = (max: number) =>
  InputTextSchema.refine((value) => value.trim().length > 0).refine((value) => value.length <= max)
export const CreateRoutineSchema = z
  .object({
    title: RoutineTextSchema(200).refine((value) => !/[\r\n]/.test(value)),
    schedule: RoutineTextSchema(200).refine((value) => !/[\r\n]/.test(value)),
    prompt: RoutineTextSchema(32000),
  })
  .strict()
export const PatchRoutineSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: CreateRoutineSchema.shape.schedule.optional(),
    prompt: CreateRoutineSchema.shape.prompt.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
export const TaskFilterSchema = z.object({
  room: z.string().min(1).optional(),
  agent: AgentIdSchema.optional(),
  needsYou: z.boolean().optional(),
  column: TaskColumnSchema.optional(),
  includeArchived: z.boolean().optional(),
})
export type TaskFilter = z.infer<typeof TaskFilterSchema>
export function matchesTask(task: TaskSummary, filter: TaskFilter): boolean {
  return (
    (filter.includeArchived || task.hermesStatus !== 'archived') &&
    (!filter.room || task.roomId === filter.room) &&
    (!filter.agent || task.assignee === filter.agent) &&
    (!filter.needsYou || task.column === 'needs_you') &&
    (!filter.column || task.column === filter.column)
  )
}

export type CompatibilityEvaluation = SystemStatus['compatibility'] & {
  matchedHermes?: { version: string; codeSha: string }
}

export type ProviderBase = Omit<ProviderItem, 'usedBy'>

export interface HermesPort {
  readonly mode: 'live' | 'fake'
  start(sink: ObservationSink): Promise<void>
  stop(): Promise<void>
  status(): Pick<SystemStatus, 'hermes' | 'bridge' | 'agentIsolation' | 'degraded'> & {
    compatibility: CompatibilityEvaluation
  }
  listAgents(): Promise<AgentSummary[]>
  listTasks(filter?: TaskFilter): Promise<TaskSummary[]>
  getTask(id: string): Promise<TaskDetail>
  createTask(req: z.infer<typeof CreateTaskSchema>, idempotencyKey: string): Promise<TaskDetail>
  patchTask(id: string, req: z.infer<typeof PatchTaskSchema>): Promise<TaskDetail>
  listAgentDetails(): Promise<AgentDetail[]>
  listRoutines(agentId: string): Promise<RoutineSummary[]>
  createRoutine(
    agentId: string,
    req: z.infer<typeof CreateRoutineSchema>,
    idempotencyKey: string,
  ): Promise<RoutineSummary>
  patchRoutine(id: string, req: z.infer<typeof PatchRoutineSchema>): Promise<RoutineSummary>
  deleteRoutine(id: string): Promise<void>
  /** Asks Hermes to run the job on its next scheduler tick; resolves once it is queued. */
  runRoutine(id: string): Promise<void>
  /** SOUL.md / AGENTS.md of a profile. A missing file reads as empty text. */
  readAgentFile(agentId: string, file: AgentFileName): Promise<AgentFile>
  /** Compare-and-swap write; rejects with AgentFileConflictError when `etag` is stale. */
  writeAgentFile(
    agentId: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }>
  /** Sets the profile's default model (and provider when given). */
  setAgentModel(agentId: string, req: { model: string; provider?: string }): Promise<void>
  listSkills(agentId: string): Promise<SkillItem[]>
  /** Installs a skill from the hub by identifier; resolves with the skills list afterwards. */
  installSkill(agentId: string, identifier: string): Promise<SkillItem[]>
  setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem>
  searchSkillHub(query: string): Promise<HubSkill[]>
  listMemory(agentId: string, query: { q?: string; cursor?: string }): Promise<MemoryPage>
  addMemory(agentId: string, text: string): Promise<MemoryItem>
  deleteMemory(agentId: string, id: string): Promise<void>
  setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool>
  /** A profile's Hermes approval settings (command_allowlist, approvals.deny, approvals.mode). */
  readApprovals(agentId: string): Promise<ApprovalConfig>
  /**
   * Read → `edit` → write → re-read verify with a bounded merge retry (409 `conflict` when a concurrent writer
   * keeps winning). Only the three approval keys are ever written. Resolves with the verified settings.
   */
  updateApprovals(
    agentId: string,
    edit: (current: ApprovalConfig) => ApprovalConfig,
  ): Promise<ApprovalConfig>
  /** Status only (never secrets); `usedBy` is added by the route from the agents' models. */
  listProviders(): Promise<ProviderBase[]>
  /** Interactive sign-ins are never run by Score: the result carries the command to run in a terminal. */
  connectProvider(id: string): Promise<ConnectResult>
  addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase>
  listConnections(): Promise<ConnectionsResponse>
  addToolServer(req: ToolServerRequest): Promise<ConnectResult>
  connectMessaging(platform: string): Promise<ConnectResult>
  startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
  }): Promise<{ runId: string }>
  stopRun(req: { agentId: string; runId: string }): Promise<void>
  taskAction(req: z.infer<typeof TaskActionRequestSchema>): Promise<{ hermesStatus: string }>
  deliverDecision(
    req: z.infer<typeof DecisionDeliveryRequestSchema>,
  ): Promise<'applied' | 'not_pending' | 'failed'>
}

export interface Scheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HermesPortDeps {
  /** The server's shared Score DB (single writer, D1). The live port never opens its own. */
  db?: ScoreDb
  scheduler?: Scheduler
  onError?: (error: unknown) => void
}

export class ApprovalDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly maybeApplied: boolean,
    readonly retryable: boolean,
  ) {
    super('Approval delivery failed')
    this.name = 'ApprovalDeliveryError'
  }
}

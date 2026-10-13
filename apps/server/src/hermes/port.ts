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
  ConfigApplyRequest,
  ConfigApplyResponse,
  ConfigChange,
  ConfigItem,
  ConfigPreviewResponse,
  ConnectResult,
  MessagingFieldsResponse,
  MessagingPlatform,
  MessagingSetupRequest,
  ConnectionsResponse,
  HermesCheck,
  LocalProviderRequest,
  ModelOption,
  ModelRef,
  PluginItem,
  ProviderItem,
  ProviderKeyRequest,
  SignIn,
  ToolServerRequest,
} from '@score/contract'
import type {
  AgentTodos,
  ModelSettings,
  ModelSettingsUpdate,
  RewindSkipReason,
  CompactFailureReason,
  SessionContextReading,
  SessionSize,
} from '@score/contract'
import { HttpError } from '../errors.ts'
import type { RewindBroker } from './bridge/rewind-broker.ts'
import type { ScoreDb } from '../db/index.ts'
import type { AgentFile, AgentFileName } from './agent-files.ts'
import type {
  AgentChannelsResponse,
  HubSkill,
  MemoryItem,
  MemoryPage,
  SkillItem,
} from '@score/contract'
import type { AgentTool } from './agent-tabs.ts'
import type { ApprovalConfig } from './approvals.ts'
import type { IngestResult, Observation } from '../hub/ingest.ts'
import type { SessionCost } from '../domain/spend.ts'
import type { JourneyFacts } from '../domain/journey.ts'
import type { ReportApproval, ReportFacts, ReportRun } from '../domain/reports.ts'
import type { ProfileManagementPort } from './profile-management.ts'
import type { OutsideSessionFact, OutsideSessionHistory } from './outside-sessions.ts'

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
      'schedule',
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
    // Comment author when an agent speaks through Score's MCP server (7.4d); absent = the owner ("score").
    author: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .refine((value) => value !== 'score')
      .optional(),
  })
  .refine((req) => req.action !== 'comment' || Boolean(req.text?.trim()))
  .refine((req) => req.author === undefined || req.action === 'comment')

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

export interface HermesPort extends ProfileManagementPort {
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
  /** Report inputs only Hermes has: reviewer send-backs and per-agent spend in [from, to] (epoch ms). */
  reportFacts(req: { from: number; to: number; agentIds: string[] }): Promise<ReportFacts>
  /**
   * Journey marks Hermes owns (7.4c): completed tasks, skill files and memory files changed in [from, to] (epoch ms).
   * Names and times only; memory contents are never read.
   */
  journeyFacts(req: { from: number; to: number; agentIds: string[] }): Promise<JourneyFacts>
  /** Live only: sessions active since `sinceMs` with cumulative cost, per readable profile, for Score's spend snapshots. */
  sessionCosts?(req: {
    sinceMs: number
    agentIds: string[]
  }): Promise<Record<string, SessionCost[]>>
  /** Fake adapter only: seeded runs and approvals that stand in for Score's own tables in demos. */
  reportHistoryRows?(
    now: number,
    agentIds: string[],
  ): Promise<{
    runs: ReportRun[]
    approvals: ReportApproval[]
    /** Demo only: dollars for each of the last 30 days, oldest first (stands in for cost snapshots). */
    trendSpendUsd?: number[]
  }>
  /** Read-only: each agent's Hermes sessions that Score did not start (PLAN 5.26). Profiles that can't be read are listed. */
  listOutsideSessions(
    agentIds: string[],
  ): Promise<{ items: OutsideSessionFact[]; unavailable: string[] }>
  /** One such session's text (user and assistant messages, redacted). Null when it doesn't exist. */
  readOutsideSession(agentId: string, sessionId: string): Promise<OutsideSessionHistory | null>
  /**
   * Whether a run can be started inside an existing Hermes session: 'same_session' when the gateway's run API takes
   * that session id (Hermes loads its history), else 'new_session' (the room starts a fresh session with a summary).
   * 'unknown' while the gateway's capabilities aren't known (startup, outage): callers must retry, never persist a fallback.
   */
  sessionContinuation(): 'same_session' | 'new_session' | 'unknown'
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
  /** Fallback chain, aliases and speech models of one profile (5.31). */
  readModelSettings(agentId: string): Promise<ModelSettings>
  /** Writes only the changed keys; answers with the settings as written. */
  updateModelSettings(agentId: string, req: ModelSettingsUpdate): Promise<ModelSettings>
  listSkills(agentId: string): Promise<SkillItem[]>
  /** Installs a skill from the hub by identifier; resolves with the skills list afterwards. */
  installSkill(agentId: string, identifier: string): Promise<SkillItem[]>
  setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem>
  searchSkillHub(query: string): Promise<HubSkill[]>
  listMemory(agentId: string, query: { q?: string; cursor?: string }): Promise<MemoryPage>
  /** Read-only messaging platform state for one agent's profile, with the command that connects each. */
  listAgentChannels(agentId: string): Promise<AgentChannelsResponse>
  addMemory(agentId: string, text: string): Promise<MemoryItem>
  deleteMemory(agentId: string, id: string): Promise<void>
  setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool>
  /** The agent's terminal folder (`terminal.cwd`) and backend (`terminal.backend`); null = not set. */
  readWorkspaceConfig(agentId: string): Promise<{ cwd: string | null; backend: string | null }>
  /** Writes `terminal.cwd`. The caller has already run the folder checks. */
  setWorkspaceCwd(agentId: string, cwd: string): Promise<void>
  /** The agent's latest todo list (read-only), or null when it has none. */
  readAgentTodos(agentId: string): Promise<AgentTodos>
  /** Hermes plugins of one profile (`plugins list`). */
  listPlugins(agentId: string): Promise<PluginItem[]>
  /** Enable or disable via the CLI and verify by re-reading. Never the Score bridge (409). */
  setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<PluginItem>
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
  /**
   * Device-code providers start a sign-in (link + code in the result, D2.7); everything else carries the command
   * to run in a terminal.
   */
  /** Models of connected providers matching `q` (at most 200, available first); [] when Hermes can't say. */
  listModels(q?: string, only?: readonly ModelRef[], limit?: number): Promise<ModelOption[]>
  /** Interactive sign-ins are never run by Score: the result carries the command to run in a terminal. */
  connectProvider(id: string): Promise<ConnectResult>
  /** In-memory sign-ins; unknown ids are 404. */
  getSignIn(id: string): Promise<SignIn>
  cancelSignIn(id: string): Promise<SignIn>
  /** Relays a pasted key to Hermes (stdin); only for `signIn: 'api_key'` providers. Never stored or logged. */
  addProviderKey(id: string, req: ProviderKeyRequest): Promise<ProviderBase>
  addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase>
  listConnections(): Promise<ConnectionsResponse>
  addToolServer(req: ToolServerRequest): Promise<ConnectResult>
  connectMessaging(platform: string): Promise<ConnectResult>
  /** Form fields for a platform's browser setup (`browserSetup: false` = terminal only). */
  messagingFields(platform: string): Promise<MessagingFieldsResponse>
  /** Writes the platform's values through `hermes config set` in the agent's profile; never stores or echoes them. */
  saveMessaging(platform: string, req: MessagingSetupRequest): Promise<MessagingPlatform>
  /** Compares the running Hermes build with the tested and accepted ones. Read-only. */
  checkHermes(): Promise<HermesCheck>
  /** Records the checked build as accepted and re-enables the gate. 409 `conflict` when the hash is stale, 409 `not_compatible`. */
  acceptHermes(hash: string): Promise<void>
  /** Advanced config (contract §10). Secret-bearing and env-backed keys are never returned or written. */
  searchConfig(query: string): Promise<ConfigItem[]>
  previewConfig(changes: ConfigChange[]): Promise<ConfigPreviewResponse>
  applyConfig(req: ConfigApplyRequest): Promise<ConfigApplyResponse>
  startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
    /** Per-request provider (an alias's own); Hermes honours it with or without `model`. */
    provider?: string
    /** Media ids of the person's image attachments, in message order. */
    images?: string[]
    /**
     * Orchestration dispatch (PLAN 7.5): the executor owns recovery of this admission, so generic intent recovery must
     * never resend it.
     */
    owner?: 'orchestration'
    /**
     * Applied to the stored input only for the payload sent to Hermes, in memory. The orchestrator uses it to insert a
     * per-turn capability that must never be stored.
     */
    render?: (stored: string) => string
  }): Promise<{ runId: string }>
  /**
   * `unconfirmed` (coding agents only) = Stop was asked but the work is not proven ended; callers must not record the
   * Stop as acknowledged and should ask again. Hermes returns nothing.
   */
  stopRun(req: { agentId: string; runId: string }): Promise<StopOutcome | void>
  /**
   * The MCP tool names the agent's serving Hermes process currently lists for the Score server (PLAN 7.5 v3.2: Hermes
   * caches the list per connection, so a freshly deployed `orch.*` needs a reload). `null` = cannot be established.
   * Absent on adapters that cannot ask.
   */
  mcpTools?(agentId: string): Promise<string[] | null>
  /**
   * Rewind one agent's room session by `turns` user turns (PLAN 5.33). Reads Hermes's own history first (the turn count
   * must match, the session must not have been compressed since `sinceMs`), then asks the Score bridge inside the
   * agent's gateway to run Hermes's own rewind. `dryRun` does the checks only. Never throws for a refusal.
   */
  rewindSession(req: {
    agentId: string
    sessionId: string
    turns: number
    /** Epoch ms of the message the room is rewound to. */
    sinceMs: number
    dryRun?: boolean
  }): Promise<RewindSessionResult>
  /**
   * Compact (summarise the older turns of) one agent's room session through the Score bridge inside its gateway (PLAN
   * 5.36). Resolves with the outcome after Hermes answers (a model call: minutes at most); never throws for a refusal.
   * Absent on adapters that cannot.
   */
  compactSession?(req: {
    agentId: string
    sessionId: string
    keepRecent?: number
  }): Promise<CompactSessionResult>
  /**
   * What uses one room session's context window, from Hermes's own accounting via the bridge (PLAN 5.36). `null` = the
   * bridge can't answer (not running, old plugin, empty session). Absent on adapters that cannot.
   */
  sessionContext?(req: {
    agentId: string
    sessionId: string
  }): Promise<SessionContextReading | null>
  taskAction(req: z.infer<typeof TaskActionRequestSchema>): Promise<{ hermesStatus: string }>
  deliverDecision(
    req: z.infer<typeof DecisionDeliveryRequestSchema>,
  ): Promise<'applied' | 'not_pending' | 'failed'>
}

export type CompactSessionResult =
  | { status: 'compacted'; before: SessionSize; after: SessionSize }
  | { status: 'nothing' }
  | { status: 'failed'; reason: CompactFailureReason }

export type RewindSessionResult =
  | { status: 'ready' }
  | { status: 'rewound'; turnsUndone: number; rewoundCount: number }
  | { status: 'skipped'; reason: RewindSkipReason }

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
  /** Reads an uploaded image by media id (wired from the media store; `hermes/` never imports it). */
  imageReader?: ImageReader
  /** Live only: how rewinds reach the Score bridge inside an agent's gateway (the bridge routes share it). */
  rewindBroker?: RewindBroker
  /**
   * Why Score holds all agent work, or null (decision 71). While non-null, recovery of unfinished start intents sends
   * nothing and delivers no Stop: whose runs those handles name can't be told. Evaluated at every recovery.
   */
  frozen?: () => string | null
}

export type ImageReader = (mediaId: string) => { contentType: string; bytes: Uint8Array } | null

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

/** Marks a refusal raised before anything was sent to Hermes (callers may conclude nothing was dispatched). */
export function notDispatched(error: unknown): unknown {
  return error instanceof HttpError
    ? new HttpError(error.status, error.code, error.message, { notDispatched: true })
    : error
}
export function isNotDispatched(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { notDispatched?: unknown }).notDispatched === true
  )
}

/** What a Stop request found: delivered to a live run, nothing to stop, or not proven ended yet. */
export type StopOutcome = 'stopped' | 'not_running' | 'unconfirmed'

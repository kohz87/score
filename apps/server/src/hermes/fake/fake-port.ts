import { AgentDetailSchema, type AgentDetail, type PluginItem } from '@score/contract'
import {
  attachRunMessage,
  appendRunMessage,
  completeRunMessage,
} from '../../domain/message-runs.ts'
import {
  AgentFileConflictError,
  assertFileContent,
  etagOf,
  excerpt,
  type AgentFile,
  type AgentFileName,
} from '../agent-files.ts'
import { fakeReportHistory } from './report-history.ts'
import { FakeWorkspaces } from './fake-workspace.ts'
import { updateProjectedAgent } from '../../domain/agents.ts'
import { createBrief, linkTask, readBriefRow } from '../../domain/briefs.ts'
import {
  recordKanbanDenial,
  closeKanbanDenialIds,
  openKanbanDenialIds,
} from '../../domain/kanban-denials.ts'
import { requestRunApproval, respondRunApproval } from '../../domain/approvals.ts'
import { recordFrame } from '../../domain/watch-frames.ts'
import { insertRoom, roomChanged, storeMessage, updateMessage } from '../../domain/rooms.ts'
import { approvalDraft, patchApproval, readApprovalRow } from '../../domain/approval-store.ts'
import type {
  AgentSummary,
  Approval,
  ConnectResult,
  ConnectionsResponse,
  AgentChannelsResponse,
  HermesCheck,
  LocalProviderRequest,
  SignIn,
  ModelOption,
  ToolServerRequest,
  RoutineSummary,
  RunSummary,
  TaskDetail,
} from '@score/contract'
import { parseSteps, writeSteps } from '../../domain/steps.ts'
import {
  projectTask,
  readProjectedTask,
  summaryDetail,
  taskWithApproval,
  taskSummary,
} from '../../domain/tasks.ts'
import { createHash, randomUUID } from 'node:crypto'
import {
  AddMemorySchema,
  HubQuerySchema,
  InstallSkillSchema,
  MEMORY_DETAIL_ITEMS,
  MemoryQuerySchema,
  SetModelSchema,
  pageMemory,
  type AgentTool,
} from '../agent-tabs.ts'
import type { HubSkill, MemoryItem, SkillItem } from '@score/contract'
import { z } from 'zod'
import { permissionsOf, updateApprovalConfig, type ApprovalConfig } from '../approvals.ts'
import { filterModels } from '../model-options.ts'
import { HttpError } from '../../errors.ts'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import type { ProfileInventory, ProfileStepContext } from '../profile-management.ts'
import type { ProfileStepName } from '@score/contract'
import { ProfileNameSchema } from '../live/paths.ts'
import { createFakeConfigService } from './fake-config.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import {
  DecisionDeliveryRequestSchema,
  TaskActionRequestSchema,
  CreateRoutineSchema,
  CreateTaskSchema,
  PatchRoutineSchema,
  PatchTaskSchema,
  TaskFilterSchema,
  matchesTask,
  type HermesPort,
  type HermesPortDeps,
  type ProviderBase,
  type ObservationSink,
  type Scheduler,
} from '../port.ts'
import {
  createScenario,
  exampleAgents,
  exampleRun,
  fakeStatus,
  type ScenarioStep,
} from './scenario.ts'

const realScheduler: Scheduler = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const memoryId = (text: string) => `m-${createHash('sha1').update(text).digest('hex').slice(0, 12)}`
const fakeHub: HubSkill[] = [
  ['changelog-writer', 'Drafts a changelog from merged pull requests.'],
  ['test-triage', 'Groups failing tests by likely cause.'],
  ['release-checklist', 'Walks through a release checklist step by step.'],
  ['meeting-notes', 'Turns a transcript into notes and action items.'],
].map(([name, description]) => ({
  name: name!,
  identifier: `example/skills/${name}`,
  source: 'official',
  trust: 'builtin',
  description: description!,
}))

export function stepToObservation(
  step: ScenarioStep,
  identity: string,
  suppressed = false,
  detail?: TaskDetail,
): Observation {
  const draft = structuredClone({ type: step.kind, data: step.data })
  return {
    source: 'fake',
    identity,
    apply({ sqlite, now }) {
      if (suppressed) return []
      if (step.kind === 'task.upserted') {
        const existing = readProjectedTask(sqlite, step.data.id)
        const next = detail ?? {
          ...(existing ?? summaryDetail(step.data)),
          ...step.data,
        }
        // Run links come from run.updated steps; a task command's detail must not drop them.
        projectTask(sqlite, {
          ...next,
          runIds: [...new Set([...(existing?.runIds ?? []), ...next.runIds])],
        })
      }
      if (step.kind === 'task.activity') {
        const task = readProjectedTask(sqlite, step.data.taskId)
        if (task)
          projectTask(sqlite, {
            ...task,
            activity: [step.data.item, ...task.activity].slice(0, 50),
          })
      }
      if (step.kind === 'agent.updated')
        return [{ type: 'agent.updated', data: updateProjectedAgent(sqlite, step.data) }]
      if (step.kind === 'room.upserted') {
        // Announce a room only once it exists, so the API and the stream never disagree.
        const room = step.data
        if (!sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(room.id))
          insertRoom(
            sqlite,
            {
              id: room.id,
              name: room.name,
              kind: room.kind,
              leadAgentId: room.leadAgentId,
              members: room.members,
            },
            now,
          )
        return roomChanged(sqlite, room.id, now)
      }
      if (step.kind === 'message.created') {
        const message = step.data
        const exists = sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(message.roomId)
        if (!exists)
          insertRoom(
            sqlite,
            {
              id: message.roomId,
              name: '#activity-feed',
              kind: 'room',
              leadAgentId: 'lead',
              members: exampleAgents().map((agent) => agent.id),
            },
            now,
          )
        const events = storeMessage(sqlite, message, now)
        const tools = message.parts.find((part) => part.kind === 'tools')
        const files = message.parts.filter((part) => part.kind === 'file')
        if (tools && files.length && !message.streaming && message.author.kind === 'agent') {
          // Scripted file replies link their run to the room, just like admitted Chat turns.
          sqlite
            .prepare(
              `INSERT INTO message_runs
               (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, '', '[]', 'completed', ?) ON CONFLICT DO NOTHING`,
            )
            .run(
              message.id,
              tools.runId,
              message.roomId,
              message.author.agentId,
              message.id,
              `fake-turn:${message.id}`,
              message.id,
              message.createdAt,
            )
          for (const [seq, file] of files.entries())
            sqlite
              .prepare(
                `INSERT INTO tool_calls
                 (run_id, seq, tool, preview, status, started_at, ended_at)
                 VALUES (?, ?, 'edit_file', ?, 'ok', ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(
                tools.runId,
                seq,
                JSON.stringify({ path: file.path }),
                message.createdAt,
                message.createdAt,
              )
        }
        if (!exists && !events.some((event) => event.type === 'room.upserted'))
          events.push(...roomChanged(sqlite, message.roomId, now))
        return events
      }
      if (step.kind === 'brief.upserted') {
        // The script's brief starts with the lead's plan turn, so Flow has a hand-off to draw.
        const brief = step.data
        const planMessage = brief.id.replace(/^message-brief-/, 'message-plan-')
        if (planMessage !== brief.id)
          sqlite
            .prepare(
              `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
               VALUES (?, ?, 'lead', ?, 0, ?, ?, ?, ?, 'active', ?) ON CONFLICT DO NOTHING`,
            )
            .run(
              planMessage,
              brief.roomId,
              brief.id,
              `fake-turn:${brief.id}`,
              brief.id,
              brief.title,
              JSON.stringify(exampleAgents().map((agent) => agent.id)),
              now,
            )
        // The step itself is the event; createBrief only stores the row (and would emit the same summary).
        createBrief(
          sqlite,
          {
            id: brief.id,
            roomId: brief.roomId,
            text: brief.title,
            startedBy: brief.startedBy,
            startedAt: brief.startedAt,
          },
          now,
        )
        return [structuredClone(draft)] as ReturnType<Observation['apply']>
      }
      if (step.kind === 'lane.upserted' && step.data.briefId && step.data.block.taskId)
        if (readBriefRow(sqlite, step.data.briefId))
          linkTask(sqlite, step.data.briefId, step.data.block.taskId, 'plan', now)
      if (step.kind === 'message.completed')
        sqlite
          .prepare(
            "UPDATE message_runs SET state = 'completed' WHERE message_id = ? AND run_id IS NULL AND state = 'active'",
          )
          .run(step.data.messageId)
      if (step.kind === 'message.delta' || step.kind === 'message.completed')
        return updateMessage(
          sqlite,
          step.data.roomId,
          step.data.messageId,
          step.kind === 'message.delta' ? step.data.append : null,
          now,
        )
      if (step.kind === 'run.updated') {
        const run = step.data
        sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, model, tools_used, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, model = excluded.model, tools_used = excluded.tools_used, updated_at = excluded.updated_at`,
          )
          .run(
            run.id,
            run.agentId,
            run.origin,
            run.status,
            run.startedAt,
            run.endedAt,
            run.model,
            JSON.stringify(run.toolsUsed),
            now,
          )
        // Runs carry their task as a ref; the task detail lists its runs (Now › Score lanes read them).
        for (const ref of run.refs) {
          if (ref.kind !== 'task') continue
          const task = readProjectedTask(sqlite, ref.taskId)
          if (task && !task.runIds.includes(run.id))
            projectTask(sqlite, { ...task, runIds: [...task.runIds, run.id] })
        }
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
          return [
            structuredClone(draft) as DomainEventDraft,
            ...completeRunMessage(sqlite, run.id, now, { handoffs: run.status === 'completed' }),
          ]
      }
      if (step.kind === 'watch.frame') {
        // Scripted frames get a per-agent seq like real ones; the script's own seq is only a sort hint.
        const frame = step.data
        const stored = recordFrame(sqlite, {
          agentId: frame.agentId,
          runId: frame.runId,
          at: frame.at,
          // Replaying the script (restart, loop) updates the same frame instead of adding a copy.
          callKey: `fake:${frame.at}:${frame.seq}`,
          surface: frame.surface,
          payload: (frame[frame.surface] ?? frame.terminal)!,
          caption: frame.caption,
        })
        return [{ type: 'watch.frame', data: stored }]
      }
      if (step.kind === 'approval.requested') {
        const approval = step.data
        if (approval.origin === 'kanban') {
          const ref = approval.refs.find((ref) => ref.kind === 'task')
          if (!ref || ref.kind !== 'task') return []
          return recordKanbanDenial(
            sqlite,
            {
              taskId: ref.taskId,
              runId: 1,
              patternKey: 'delete',
              commandDigest: createHash('sha256').update(approval.command).digest('hex'),
            },
            { profile: approval.agentId, id: 'fake', incarnation: 'fake' },
            approval.command,
            approval.createdAt,
            approval.id,
          )
        }
        const runId = `fake-approval-run:${approval.id}`
        sqlite
          .prepare(
            `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, ?, 'score', 'waiting_for_approval', ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(runId, approval.agentId, approval.createdAt, now)
        const drafts = requestRunApproval(
          sqlite,
          {
            id: approval.id,
            profile: approval.agentId,
            runId,
            requestId: approval.id,
            command: approval.command,
            description: `${approval.title}\n${approval.description}`,
            choices: approval.choices,
          },
          approval.createdAt,
        )
        patchApproval(
          sqlite,
          approval.id,
          {
            origin: approval.origin,
            blocking: approval.blocking,
            kanban_task_id: approval.refs.find((ref) => ref.kind === 'task')?.taskId ?? null,
          },
          now,
        )
        return drafts.length
          ? approvalDraft(
              sqlite,
              approval.id,
              { now: Date.parse(now) },
              drafts.some((event) => event.type === 'approval.requested'),
            )
          : []
      }
      if (step.kind === 'approval.updated') {
        const row = readApprovalRow(sqlite, step.data.id)
        if (!row) return []
        if (row.origin === 'kanban' && step.data.status === 'withdrawn') {
          patchApproval(sqlite, row.id, { closed_reason: 'task_moved', closed_at: now }, now)
          return approvalDraft(sqlite, row.id)
        }
        // The demo run that carried the approval stops waiting once it is decided or withdrawn.
        const closeRun = () => {
          if (step.data.status !== 'pending')
            sqlite
              .prepare(
                `UPDATE runs SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_approval'`,
              )
              .run(now, now, `fake-approval-run:${row.id}`)
        }
        if (step.data.decision) {
          const drafts = respondRunApproval(
            sqlite,
            row.profile,
            row.session_key,
            row.request_id!,
            step.data.decision.choice,
            step.data.decision.at,
          )
          closeRun()
          return drafts
        }
        patchApproval(sqlite, row.id, { blocking: step.data.blocking }, now)
        closeRun()
        return approvalDraft(sqlite, row.id, { now: Date.parse(now) })
      }
      return [structuredClone(draft)] as ReturnType<Observation['apply']>
    },
  }
}

export class FakePort implements HermesPort {
  readonly mode = 'fake'
  private readonly db: HermesPortDeps['db']
  private readonly scheduler: Scheduler
  private readonly onError: (error: unknown) => void
  private readonly timers = new Set<unknown>()
  private readonly approvals = new Map<string, Approval>()
  private readonly tasks = new Map<string, TaskDetail>()
  private readonly taskOverrides = new Map<string, string>()
  private readonly runs = new Map<string, RunSummary>()
  private readonly turns = new Map<string, string>()
  private agents = new Map<string, AgentSummary>()
  private readonly routines = new Map<string, RoutineSummary>()
  private readonly routineKeys = new Map<string, string>()
  private routineCount = 0
  private readonly files = new Map<string, string>()
  private readonly models = new Map<string, { model: AgentSummary['model']; via: string }>()
  private readonly skills = new Map<string, SkillItem[]>()
  private readonly memory = new Map<string, MemoryItem[]>()
  private readonly tools = new Map<string, AgentTool[]>()
  private readonly plugins = new Map<string, PluginItem[]>()
  private readonly approvalConfigs = new Map<string, ApprovalConfig>()
  private readonly profileIdentities = new Map<string, string>()
  private readonly profileSteps = new Map<string, Set<ProfileStepName>>()
  private sink: ObservationSink | undefined
  private sessionId = ''
  private nextIdentity = 0
  private loop = 0
  private tail: Promise<void> = Promise.resolve()
  private stopping: Promise<void> | undefined

  constructor(
    private readonly speed = 1,
    deps: HermesPortDeps = {},
    private readonly looping = true,
    private readonly reply: (req: Parameters<HermesPort['startRun']>[0]) => {
      text: string
      tools: string[]
    } = () => ({
      text: 'I have reviewed the room context. The work is ready for the next step.',
      tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
    }),
    // Dev and e2e only: a believable month of finished work so Reports has something to show.
    private readonly seedReportHistory = false,
  ) {
    if (!Number.isFinite(speed) || speed <= 0)
      throw new Error('Fake speed must be positive and finite')
    this.db = deps.db
    this.scheduler = deps.scheduler ?? realScheduler
    this.onError = deps.onError ?? ((error) => console.error('Fake observation failed', error))
    this.resetState()
  }

  private resetState(): void {
    this.workspaces.dispose()
    this.agents = new Map(exampleAgents().map((agent) => [agent.id, agent]))
    this.files.clear()
    for (const agent of this.agents.values()) {
      this.files.set(`${agent.id}/SOUL.md`, `# ${agent.id}\n\nI am ${agent.id}. ${agent.role}.\n`)
      this.files.set(`${agent.id}/AGENTS.md`, `# Rules for ${agent.id}\n\n- Keep changes small.\n`)
    }
    this.approvals.clear()
    this.tasks.clear()
    this.taskOverrides.clear()
    this.runs.clear()
    this.turns.clear()
    this.routines.clear()
    this.routineKeys.clear()
    this.models.clear()
    this.skills.clear()
    this.memory.clear()
    this.tools.clear()
    this.plugins.clear()
    const at = new Date(this.scheduler.now()).toISOString()
    for (const agent of this.agents.values()) {
      this.skills.set(agent.id, [
        { name: 'collaboration', enabled: true },
        { name: 'code-review', enabled: true },
        { name: 'release-notes', enabled: false },
      ])
      this.memory.set(
        agent.id,
        [
          ['Prefers short status updates.', 'About you'],
          ['The test suite runs with pnpm test.', 'Agent notes'],
          ['Releases go out on Fridays.', 'Agent notes'],
        ].map(([text, source]) => ({ id: memoryId(text!), text: text!, source: source!, at })),
      )
      this.tools.set(agent.id, [
        { id: 'terminal', label: 'Terminal & Processes', kind: 'builtin', enabled: true },
        { id: 'file', label: 'File Operations', kind: 'builtin', enabled: true },
        { id: 'web', label: 'Web Search & Scraping', kind: 'builtin', enabled: true },
        { id: 'browser', label: 'Browser Automation', kind: 'builtin', enabled: false },
        { id: 'tracker', label: 'tracker', kind: 'mcp', enabled: true },
      ])
    }
    if (this.db) {
      const rows = z
        .array(z.object({ name: z.string(), state: z.string() }))
        .parse(this.db.sqlite.prepare('SELECT * FROM fake_profiles').all())
      for (const row of rows) {
        const saved = z
          .object({
            detail: AgentDetailSchema.nullable(),
            identity: z.string().nullable(),
            steps: z.array(z.string()),
            approvals: z.object({
              mode: z.enum(['manual', 'smart', 'off']),
              allowlist: z.array(z.string()),
              deny: z.array(z.string()),
            }),
            soul: z.string(),
          })
          .parse(JSON.parse(row.state))
        if (!saved.detail) {
          this.agents.delete(row.name)
          continue
        }
        this.agents.set(row.name, saved.detail)
        this.memory.set(row.name, saved.detail.memory)
        this.skills.set(row.name, saved.detail.skills)
        this.tools.set(row.name, saved.detail.tools)
        this.approvalConfigs.set(row.name, saved.approvals)
        this.files.set(`${row.name}/SOUL.md`, saved.soul)
        if (saved.identity) this.profileIdentities.set(row.name, saved.identity)
        this.profileSteps.set(row.name, new Set(saved.steps as ProfileStepName[]))
      }
    }
  }

  async start(sink: ObservationSink): Promise<void> {
    if (this.stopping) await this.stopping
    if (this.sink) return
    this.resetState()
    this.sessionId = randomUUID()
    this.sink = sink
    this.loop = 0
    this.scheduleScenario()
  }

  private scheduleScenario(): void {
    const startedAt = this.scheduler.now()
    const sessionId = this.sessionId
    const steps = createScenario(startedAt, this.loop)
    this.nextIdentity = steps.length
    const scheduleStep = (index: number): void => {
      if (!this.sink || this.sessionId !== sessionId) return
      const step = steps[index]
      if (!step) {
        if (this.looping)
          this.schedule(10000, async () => {
            this.loop++
            this.scheduleScenario()
          })
        return
      }
      // Only one script timer is armed, so overdue timers cannot reorder the session.
      const remaining = Math.max(0, startedAt + step.at / this.speed - this.scheduler.now())
      this.schedule(remaining, async () => {
        try {
          await this.emit(step, `${this.loop}:${index}`)
        } finally {
          scheduleStep(index + 1)
        }
      })
    }
    scheduleStep(0)
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.sink = undefined
    for (const timer of this.timers) this.scheduler.clearTimeout(timer)
    this.timers.clear()
    const stopping = this.tail.then(() => {
      this.stopping = undefined
    })
    this.stopping = stopping
    return stopping
  }

  status(): ReturnType<HermesPort['status']> {
    return fakeStatus()
  }

  async listAgents(): Promise<AgentSummary[]> {
    return structuredClone([...this.agents.values()])
  }
  async profileInventory(name: string, cloneFrom?: string): Promise<ProfileInventory> {
    ProfileNameSchema.parse(name)
    const source = cloneFrom ? this.agentOrThrow(cloneFrom) : null
    const inherited = {
      memories: source ? ['MEMORY.md', 'USER.md'] : [],
      skills: source ? (this.skills.get(source.id) ?? []).map((item) => item.name) : [],
      plugins: source ? ['score-bridge'] : [],
      approvalSettings: source ? ['mode: smart', 'command allowlist', 'deny rules'] : [],
      credentialsPresent: source ? ['example-provider'] : [],
    }
    const exists = this.agents.has(name)
    return {
      exists,
      identity: exists ? (this.profileIdentities.get(name) ?? `fake-existing:${name}`) : null,
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            this.agents.get(name),
            source,
            inherited,
            source ? this.memory.get(source.id) : null,
            source ? this.approvalConfigs.get(source.id) : null,
          ]),
        )
        .digest('hex'),
      inherited,
      blockers: [],
    }
  }
  profileExportPath(name: string, revision: string) {
    ProfileNameSchema.parse(name)
    // Fake mode never writes an archive; this is the private destination shown by the simulated adapter.
    return `${this.db ? this.profileScoreHome() : '/tmp/score-fake'}/profile-backups/${name}-${revision.slice(0, 24)}.tar.gz`
  }
  private profileScoreHome() {
    const row = z
      .object({ file: z.string() })
      .parse(this.db!.sqlite.prepare('PRAGMA database_list').get())
    return row.file.slice(0, row.file.lastIndexOf('/'))
  }
  async describeProfile(name: string, description: string) {
    this.agentOrThrow(name).role = description
  }
  async profileStep(step: ProfileStepName, context: ProfileStepContext) {
    const name = ProfileNameSchema.parse(context.targetName)
    const input = context.input
    let current =
      this.profileIdentities.get(name) ?? (this.agents.has(name) ? `fake-existing:${name}` : null)
    if (
      step !== 'create_profile' &&
      !['purge_identity', 'retire'].includes(step) &&
      current !== context.targetIdentity
    )
      throw new HttpError(409, 'conflict', 'Profile identity changed')
    if (step === 'create_profile') {
      if (this.agents.has(name) || !input)
        throw new HttpError(409, 'conflict', 'Profile already exists')
      // A small observable provisioning interval keeps fake mode faithful to the asynchronous operation UI.
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      const source = input.cloneFrom ? this.agentOrThrow(input.cloneFrom) : null
      this.agents.set(name, {
        ...(source ?? exampleAgents()[0]!),
        id: name,
        name: input.name,
        role: input.role,
        style: input.style,
        status: 'idle',
        activity: null,
        served: true,
      })
      if (source) {
        this.skills.set(name, structuredClone(this.skills.get(source.id) ?? []))
        this.memory.set(name, structuredClone(this.memory.get(source.id) ?? []))
        this.files.set(`${name}/SOUL.md`, this.files.get(`${source.id}/SOUL.md`) ?? '')
      }
      current = `fake:${context.operationId}`
      this.profileIdentities.set(name, current)
    } else if (step === 'model') {
      await this.setAgentModel(name, {
        model: input!.model,
        ...(input!.provider ? { provider: input!.provider } : {}),
      })
    } else if (step === 'permissions') {
      await this.updateApprovals(name, () => ({
        mode: context.baseline.mode,
        allowlist: context.baseline.goAhead,
        deny: context.baseline.never,
      }))
    } else if (step === 'delete_profile') {
      if (!this.profileSteps.get(name)?.has('export'))
        throw new HttpError(409, 'conflict', 'No verified export')
      this.agents.delete(name)
      this.profileIdentities.delete(name)
    } else if (step === 'verify_ready') {
      const steps = this.profileSteps.get(name)
      if (
        ![
          'preserve_key',
          'configure_key',
          'model',
          'permissions',
          'install_bridge',
          'enable_bridge',
        ].every((key) => steps?.has(key as ProfileStepName))
      )
        throw new HttpError(409, 'conflict', 'Provisioning checks failed')
    }
    const steps = this.profileSteps.get(name) ?? new Set<ProfileStepName>()
    steps.add(step)
    this.profileSteps.set(name, steps)
    if (this.db) {
      const detail = (await this.listAgentDetails()).find((agent) => agent.id === name) ?? null
      this.db.sqlite
        .prepare(
          'INSERT INTO fake_profiles (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state',
        )
        .run(
          name,
          JSON.stringify({
            detail,
            identity: current,
            steps: [...steps],
            approvals: this.approvalConfigs.get(name) ?? { mode: 'smart', allowlist: [], deny: [] },
            soul: this.files.get(`${name}/SOUL.md`) ?? '',
          }),
        )
    }
    return { identity: current ?? context.targetIdentity }
  }

  async reportFacts(req: Parameters<HermesPort['reportFacts']>[0]) {
    // Neutral, deterministic numbers that grow with the window so the three ranges look different.
    const days = Math.max(1, Math.ceil((req.to - req.from) / 86_400_000))
    const history = this.seedReportHistory ? fakeReportHistory(req.to, req.agentIds) : null
    if (history) {
      return {
        tasks: history.tasks,
        spendUsd: Object.fromEntries(
          req.agentIds.map((id) => [
            id,
            Math.round(days * (history.spendPerDay[id] ?? 0.5) * 100) / 100,
          ]),
        ),
      }
    }
    return {
      tasks: [...this.tasks.values()].map((task) => {
        const done = task.hermesStatus === 'done'
        const finishedAt = Date.parse(task.updatedAt)
        const sentBack = task.badge?.kind === 'changes_requested'
        const reviewed = Boolean(task.reviewer) || sentBack
        return {
          id: task.id,
          assignee: task.assignee,
          status: task.hermesStatus,
          createdAt: finishedAt - (task.elapsedSec ?? 600) * 1000,
          completedAt: done ? finishedAt : null,
          hasParents: task.dependsOn.length > 0,
          events: [
            ...(reviewed
              ? [
                  {
                    id: 1,
                    kind: 'review_requested',
                    at: finishedAt - 120_000,
                    actor: task.assignee,
                  },
                ]
              : []),
            ...(sentBack
              ? [{ id: 2, kind: 'changes_requested', at: finishedAt - 60_000, actor: null }]
              : []),
          ],
        }
      }),
      spendUsd: Object.fromEntries(
        req.agentIds.map((agentId, i) => [
          agentId,
          Math.round(days * (0.35 + 0.1 * i) * 100) / 100,
        ]),
      ),
    }
  }

  async reportHistoryRows(now: number, agentIds: string[]) {
    const { runs, approvals } = fakeReportHistory(now, agentIds)
    return this.seedReportHistory ? { runs, approvals } : { runs: [], approvals: [] }
  }

  async listAgentDetails(): Promise<AgentDetail[]> {
    return (await this.listAgents()).map((agent) =>
      AgentDetailSchema.parse({
        ...agent,
        tagline: agent.role,
        personality: {
          excerpt: excerpt(this.files.get(`${agent.id}/SOUL.md`) ?? ''),
          source: 'SOUL.md',
        },
        reportsTo: agent.id === 'lead' ? null : 'lead',
        worksIn: null,
        rulesFile: 'AGENTS.md',
        model: agent.model
          ? { ...agent.model, via: this.models.get(agent.id)?.via ?? 'Demo', fallback: null }
          : null,
        skills: structuredClone(this.skills.get(agent.id) ?? []),
        memory: structuredClone((this.memory.get(agent.id) ?? []).slice(0, MEMORY_DETAIL_ITEMS)),
        tools: structuredClone(this.tools.get(agent.id) ?? []),
        helpersMax: 3,
        routines: this.routinesOf(agent.id),
        channels: [],
        permissions: permissionsOf(this.approvalConfigs.get(agent.id) ?? null),
      }),
    )
  }

  async readApprovals(agentId: string): Promise<ApprovalConfig> {
    this.agentOrThrow(agentId)
    return structuredClone(
      this.approvalConfigs.get(agentId) ?? { mode: 'smart', allowlist: [], deny: [] },
    )
  }
  async updateApprovals(
    agentId: string,
    edit: (current: ApprovalConfig) => ApprovalConfig,
  ): Promise<ApprovalConfig> {
    // Same loop as the live adapter, over an in-memory "config".
    return updateApprovalConfig(
      {
        read: () => this.readApprovals(agentId),
        write: async (_current, next) => {
          this.approvalConfigs.set(agentId, structuredClone(next))
        },
      },
      edit,
    )
  }
  private agentOrThrow(agentId: string): AgentSummary {
    const agent = this.agents.get(agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found')
    return agent
  }
  async setAgentModel(agentId: string, input: Parameters<HermesPort['setAgentModel']>[1]) {
    const req = SetModelSchema.parse(input)
    const agent = this.agentOrThrow(agentId)
    const model = { id: req.model, label: req.model }
    agent.model = model
    this.models.set(agentId, {
      model,
      via: req.provider ?? this.models.get(agentId)?.via ?? 'Demo',
    })
  }
  async listSkills(agentId: string): Promise<SkillItem[]> {
    this.agentOrThrow(agentId)
    return structuredClone(this.skills.get(agentId) ?? [])
  }
  async installSkill(agentId: string, identifier: string): Promise<SkillItem[]> {
    this.agentOrThrow(agentId)
    const name = InstallSkillSchema.parse({ name: identifier }).name.split('/').pop()!
    const skills = this.skills.get(agentId) ?? []
    if (!skills.some((skill) => skill.name === name)) skills.push({ name, enabled: true })
    this.skills.set(agentId, skills)
    return structuredClone(skills)
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean): Promise<SkillItem> {
    this.agentOrThrow(agentId)
    const skill = this.skills.get(agentId)?.find((candidate) => candidate.name === name)
    if (!skill) throw new HttpError(404, 'not_found', 'Skill not found')
    skill.enabled = enabled
    return structuredClone(skill)
  }
  async searchSkillHub(query: string): Promise<HubSkill[]> {
    const q = HubQuerySchema.parse(query).trim().toLowerCase()
    if (!q) return []
    return fakeHub.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(q))
  }
  async listAgentChannels(agentId: string): Promise<AgentChannelsResponse> {
    this.agentOrThrow(agentId)
    const { messaging } = await this.listConnections()
    return {
      items: messaging.map((row) => ({
        ...row,
        connectCommand: `hermes -p ${agentId} gateway setup`,
      })),
    }
  }
  async listMemory(agentId: string, query: Parameters<HermesPort['listMemory']>[1]) {
    this.agentOrThrow(agentId)
    return pageMemory(this.memory.get(agentId) ?? [], MemoryQuerySchema.parse(query))
  }
  async addMemory(agentId: string, text: string): Promise<MemoryItem> {
    this.agentOrThrow(agentId)
    const clean = AddMemorySchema.parse({ text }).text.trim()
    const items = this.memory.get(agentId) ?? []
    const existing = items.find((item) => item.text === clean)
    if (existing) return structuredClone(existing)
    const item = {
      id: memoryId(clean),
      text: clean,
      source: 'Agent notes',
      at: new Date(this.scheduler.now()).toISOString(),
    }
    this.memory.set(agentId, [item, ...items])
    return structuredClone(item)
  }
  async deleteMemory(agentId: string, id: string): Promise<void> {
    this.agentOrThrow(agentId)
    const items = this.memory.get(agentId) ?? []
    if (!items.some((item) => item.id === id))
      throw new HttpError(404, 'not_found', 'Memory not found')
    this.memory.set(
      agentId,
      items.filter((item) => item.id !== id),
    )
  }
  private readonly workspaces = new FakeWorkspaces()
  /** Removes the temp-dir workspaces (tests; the process-exit hook does it otherwise). */
  workspaceDispose(): void {
    this.workspaces.dispose()
  }
  async readWorkspaceConfig(agentId: string) {
    this.agentOrThrow(agentId)
    return { cwd: this.workspaces.cwdOf(agentId), backend: this.workspaces.backendOf(agentId) }
  }
  async setWorkspaceCwd(agentId: string, cwd: string): Promise<void> {
    this.agentOrThrow(agentId)
    this.workspaces.set(agentId, cwd)
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean): Promise<AgentTool> {
    this.agentOrThrow(agentId)
    const tool = this.tools.get(agentId)?.find((candidate) => candidate.id === toolId)
    if (!tool) throw new HttpError(404, 'not_found', 'Tool not found')
    if (tool.kind === 'mcp')
      throw new HttpError(501, 'not_implemented', 'MCP servers are shown read-only')
    tool.enabled = enabled
    return structuredClone(tool)
  }

  async listPlugins(agentId: string): Promise<PluginItem[]> {
    return structuredClone(this.pluginsOf(agentId))
  }
  private pluginsOf(agentId: string): PluginItem[] {
    this.agentOrThrow(agentId)
    let plugins = this.plugins.get(agentId)
    if (!plugins) {
      const demo = (id: string, enabled: boolean, description: string | null, locked = false) => ({
        id,
        label: id,
        enabled,
        locked,
        description,
      })
      plugins = [
        demo('score-bridge', true, 'Lets Score see what this agent does.', true),
        demo('memory-notes', true, 'Keeps short notes between sessions.'),
        demo('browser-helper', false, 'Adds a cloud browser tool.'),
        demo('image-tools', false, null),
      ]
      this.plugins.set(agentId, plugins)
    }
    return plugins
  }
  async setPluginEnabled(agentId: string, id: string, enabled: boolean): Promise<PluginItem> {
    const plugin = this.pluginsOf(agentId).find((candidate) => candidate.id === id)
    if (!plugin) throw new HttpError(404, 'not_found', 'Plugin not found')
    if (plugin.locked)
      throw new HttpError(
        409,
        'conflict',
        'The Score bridge stays on: Score needs it to see Hermes',
      )
    plugin.enabled = enabled
    return structuredClone(plugin)
  }

  private routinesOf(agentId: string): RoutineSummary[] {
    return structuredClone(
      [...this.routines.values()].filter((routine) => routine.id.startsWith(`${agentId}:`)),
    )
  }
  private routine(id: string): RoutineSummary {
    const routine = this.routines.get(id)
    if (!routine) throw new HttpError(404, 'not_found', 'Unknown routine')
    return routine
  }
  async listRoutines(agentId: string): Promise<RoutineSummary[]> {
    if (!this.agents.has(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    return this.routinesOf(agentId)
  }
  async createRoutine(
    agentId: string,
    input: Parameters<HermesPort['createRoutine']>[1],
    key: string,
  ): Promise<RoutineSummary> {
    const req = CreateRoutineSchema.parse(input)
    if (!this.agents.has(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    const intent = `${agentId}:${key}`
    const known = this.routineKeys.get(intent)
    if (known) return structuredClone(this.routine(known))
    const id = `${agentId}:fake-routine-${++this.routineCount}`
    const routine: RoutineSummary = {
      id,
      title: req.title,
      schedule: req.schedule,
      description: req.prompt.slice(0, 600),
      lastRunAt: null,
      enabled: true,
    }
    this.routines.set(id, routine)
    this.routineKeys.set(intent, id)
    return structuredClone(routine)
  }
  async patchRoutine(
    id: string,
    input: Parameters<HermesPort['patchRoutine']>[1],
  ): Promise<RoutineSummary> {
    const req = PatchRoutineSchema.parse(input)
    const routine = this.routine(id)
    if (req.enabled !== undefined) routine.enabled = req.enabled
    if (req.schedule !== undefined) routine.schedule = req.schedule
    if (req.prompt !== undefined) routine.description = req.prompt.slice(0, 600)
    return structuredClone(routine)
  }
  async deleteRoutine(id: string): Promise<void> {
    this.routine(id)
    this.routines.delete(id)
  }
  async runRoutine(id: string): Promise<void> {
    // Real Hermes runs on its next tick; the fake records the run immediately.
    this.routine(id).lastRunAt = this.now()
  }
  // One provider of each sign-in kind: nous (device code), openrouter (pasted key), anthropic (terminal only).
  private readonly fakeProviders: ProviderBase[] = [
    {
      id: 'demo',
      label: 'Demo',
      status: 'connected',
      detail: 'Built-in demo models',
      signIn: 'terminal',
    },
    {
      id: 'openrouter',
      label: 'OpenRouter',
      status: 'missing',
      detail: 'Not connected',
      signIn: 'api_key',
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      status: 'needs_signin',
      detail: 'Session expired',
      signIn: 'terminal',
    },
    {
      id: 'openai-codex',
      label: 'ChatGPT (Codex)',
      status: 'connected',
      detail: 'Your ChatGPT plan',
      signIn: 'device_code',
    },
    {
      id: 'nous',
      label: 'Nous Portal',
      status: 'missing',
      detail: 'Not connected',
      signIn: 'device_code',
    },
  ]
  // Fake sign-ins finish on the third status read (the mount read plus two 2 s polls), so e2e is deterministic.
  private readonly fakeSignIns = new Map<string, { signIn: SignIn; reads: number }>()
  private readonly fakeModels: ModelOption[] = [
    ...['gpt-6.1-sol', 'gpt-6-luna'].map((model) => ({
      provider: 'openai-codex',
      providerLabel: 'ChatGPT (Codex)',
      model,
      available: true,
      reason: null,
      free: false,
      price: { input: '$2.00', output: '$10.00' },
    })),
    {
      provider: 'nous',
      providerLabel: 'Nous Portal',
      model: 'openai/gpt-6.1-sol',
      available: false,
      reason: 'Not on your plan',
      free: false,
      price: { input: '$2.50', output: '$12.00' },
    },
    {
      provider: 'nous',
      providerLabel: 'Nous Portal',
      model: 'upstage/solar-mini4:free',
      available: true,
      reason: null,
      free: true,
      price: null,
    },
    {
      provider: 'local',
      providerLabel: 'Local server',
      model: 'local-gpt-mini',
      available: true,
      reason: null,
      free: true,
      price: null,
    },
  ]
  async listModels(q?: string): Promise<ModelOption[]> {
    return structuredClone(filterModels(this.fakeModels, q))
  }
  async listProviders(): Promise<ProviderBase[]> {
    return structuredClone(this.fakeProviders)
  }
  async connectProvider(id: string): Promise<ConnectResult> {
    const provider = this.fakeProviders.find((candidate) => candidate.id === id)
    if (!provider) throw new HttpError(404, 'not_found', 'Unknown provider')
    const command = `hermes auth add ${id}`
    if (provider.signIn !== 'device_code') return { next: 'run_in_terminal', command }
    let entry = [...this.fakeSignIns.values()].find(
      (candidate) => candidate.signIn.providerId === id && candidate.signIn.state === 'waiting',
    )
    if (!entry) {
      entry = {
        reads: 0,
        signIn: {
          id: `fake-${this.fakeSignIns.size + 1}`,
          providerId: id,
          state: 'waiting',
          url: 'https://example.com/device',
          code: 'WXYZ-1234',
          expiresAt: new Date(this.scheduler.now() + 15 * 60_000).toISOString(),
          message: null,
        },
      }
      this.fakeSignIns.set(entry.signIn.id, entry)
    }
    const { signIn } = entry
    return {
      next: 'device_code',
      command,
      url: signIn.url!,
      code: signIn.code!,
      signInId: signIn.id,
      expiresAt: signIn.expiresAt,
    }
  }
  private fakeSignIn(id: string) {
    const entry = this.fakeSignIns.get(id)
    if (!entry) throw new HttpError(404, 'not_found', 'Unknown sign-in')
    return entry
  }
  async getSignIn(id: string): Promise<SignIn> {
    const entry = this.fakeSignIn(id)
    if (entry.signIn.state === 'waiting' && ++entry.reads >= 3) {
      entry.signIn = { ...entry.signIn, state: 'connected', url: null, code: null }
      const provider = this.fakeProviders.find((p) => p.id === entry.signIn.providerId)
      if (provider) Object.assign(provider, { status: 'connected', detail: 'Signed in' })
    }
    return structuredClone(entry.signIn)
  }
  async cancelSignIn(id: string): Promise<SignIn> {
    const entry = this.fakeSignIn(id)
    if (entry.signIn.state === 'waiting')
      entry.signIn = { ...entry.signIn, state: 'cancelled', url: null, code: null }
    return structuredClone(entry.signIn)
  }
  async addProviderKey(id: string): Promise<ProviderBase> {
    const provider = this.fakeProviders.find((candidate) => candidate.id === id)
    if (!provider) throw new HttpError(404, 'not_found', 'Unknown provider')
    if (provider.signIn !== 'api_key')
      throw new HttpError(409, 'not_supported', 'This provider does not take a pasted key')
    // The fake keeps no key, just like the live adapter.
    Object.assign(provider, { status: 'connected', detail: 'API key (1)' })
    return structuredClone(provider)
  }
  async addLocalProvider(req: LocalProviderRequest): Promise<ProviderBase> {
    const id = req.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!id) throw new HttpError(400, 'bad_request', 'Invalid request')
    if (this.fakeProviders.some((provider) => provider.id === id))
      throw new HttpError(409, 'conflict', 'A provider with that name already exists')
    const provider: ProviderBase = {
      id,
      label: req.label,
      status: 'connected',
      detail: new URL(req.baseUrl).host,
    }
    this.fakeProviders.push(provider)
    return structuredClone(provider)
  }
  async listConnections(): Promise<ConnectionsResponse> {
    return {
      toolServers: [
        { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' },
        { id: 'web-search', label: 'web-search', status: 'needs_signin', usedBy: 'everyone' },
        { id: 'issue-tracker', label: 'issue-tracker', status: 'error', usedBy: 'everyone' },
      ],
      messaging: [
        { platform: 'telegram', label: 'Telegram', status: 'connected', detail: null },
        { platform: 'discord', label: 'Discord', status: 'disconnected', detail: null },
        { platform: 'slack', label: 'Slack', status: 'disconnected', detail: 'auth_failed' },
      ],
    }
  }
  async addToolServer(req: ToolServerRequest): Promise<ConnectResult> {
    return { next: 'run_in_terminal', command: `hermes mcp add ${req.name}` }
  }
  async connectMessaging(platform: string): Promise<ConnectResult> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform))
      throw new HttpError(404, 'not_found', 'Unknown platform')
    return { next: 'run_in_terminal', command: 'hermes gateway setup' }
  }
  // The fake Hermes is always the tested build: a check is clean and accepting changes nothing.
  async checkHermes(): Promise<HermesCheck> {
    return {
      hash: '0'.repeat(64),
      build: { version: null, codeSha: null, fingerprint: 'fake' },
      parts: [{ name: 'Capabilities', status: 'same', detail: 'Fake adapter' }],
      compatible: true,
    }
  }
  async acceptHermes(): Promise<void> {}
  private readonly config = createFakeConfigService()
  async searchConfig(query: string) {
    return this.config.search(query)
  }
  async previewConfig(changes: Parameters<HermesPort['previewConfig']>[0]) {
    return this.config.preview(changes)
  }
  async applyConfig(req: Parameters<HermesPort['applyConfig']>[0]) {
    return this.config.apply(req)
  }
  async readAgentFile(agentId: string, file: AgentFileName): Promise<AgentFile> {
    if (!this.agents.has(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    const content = this.files.get(`${agentId}/${file}`) ?? ''
    return { content, etag: etagOf(content) }
  }

  async writeAgentFile(
    agentId: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }> {
    assertFileContent(content)
    const current = await this.readAgentFile(agentId, file)
    if (current.etag !== etag) throw new AgentFileConflictError(current)
    this.files.set(`${agentId}/${file}`, content)
    return { etag: etagOf(content) }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private schedule(delayMs: number, work: () => Promise<void>): void {
    if (!this.sink) return
    const sessionId = this.sessionId
    const timer = this.scheduler.setTimeout(() => {
      this.timers.delete(timer)
      void this.enqueue(async () => {
        if (!this.sink || this.sessionId !== sessionId) return
        await work()
      }).catch(this.onError)
    }, delayMs)
    this.timers.add(timer)
  }

  private requireSink(): ObservationSink {
    if (!this.sink) throw new HttpError(503, 'hermes_unavailable', 'Fake adapter is not started')
    return this.sink
  }

  private async emit(
    step: ScenarioStep,
    index = `${this.loop}:command:${this.nextIdentity++}`,
    detail?: TaskDetail,
  ): Promise<void> {
    // A model chosen through the Team page outlives the script's own agent updates.
    if (step.kind === 'agent.updated' && this.models.has(step.data.id))
      step = { ...step, data: { ...step.data, model: this.models.get(step.data.id)!.model } }
    // Delayed script steps cannot undo commands delivered while the scenario was playing.
    const suppressed = Boolean(
      (step.kind === 'task.upserted' &&
        !index.includes(':command:') &&
        this.taskOverrides.has(step.data.id) &&
        step.data.hermesStatus !== this.taskOverrides.get(step.data.id)) ||
      (step.kind === 'approval.updated' && this.approvals.get(step.data.id)?.decision) ||
      (step.kind === 'run.updated' &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          this.runs.get(step.data.id)?.status ?? '',
        )),
    )
    await this.requireSink().submit(
      stepToObservation(step, `${this.sessionId}:${index}`, suppressed, detail),
    )
    if (suppressed) return
    switch (step.kind) {
      case 'task.upserted':
        this.tasks.set(step.data.id, {
          ...(detail ?? this.tasks.get(step.data.id) ?? summaryDetail(step.data)),
          ...structuredClone(step.data),
        })
        break
      case 'task.activity': {
        const task = this.tasks.get(step.data.taskId)
        if (task) task.activity = [structuredClone(step.data.item), ...task.activity].slice(0, 50)
        break
      }
      case 'agent.updated':
        this.agents.set(step.data.id, structuredClone(step.data))
        break
      case 'approval.requested':
      case 'approval.updated':
        this.approvals.set(step.data.id, structuredClone(step.data))
        break
      case 'run.updated':
        this.runs.set(step.data.id, structuredClone(step.data))
        break
    }
  }

  private now(): string {
    return new Date(this.scheduler.now()).toISOString()
  }

  async listTasks(filter: Parameters<HermesPort['listTasks']>[0] = {}) {
    const parsed = TaskFilterSchema.parse(filter)
    return [...this.tasks.values()]
      .map((task) => this.viewTask(task))
      .filter((task) => matchesTask(task, parsed))
      .map(taskSummary)
  }
  private viewTask(task: TaskDetail): TaskDetail {
    if (this.db)
      return this.db.read((sqlite) => taskWithApproval(sqlite, task, this.scheduler.now()))
    const approval =
      [...this.approvals.values()].find(
        (approval) =>
          approval.status === 'pending' &&
          approval.refs.some((ref) => ref.kind === 'task' && ref.taskId === task.id),
      ) ?? null
    return structuredClone(
      approval ? { ...task, column: 'needs_you', progress: null, pendingApproval: approval } : task,
    )
  }
  async getTask(id: string): Promise<TaskDetail> {
    const task = this.tasks.get(id)
    if (!task) throw new HttpError(404, 'not_found', 'Unknown task')
    return this.viewTask(task)
  }
  createTask(input: Parameters<HermesPort['createTask']>[0], key: string): Promise<TaskDetail> {
    return this.enqueue(async () => {
      this.requireSink()
      const req = CreateTaskSchema.parse(input)
      // Same as the live adapter: Hermes takes a reviewer only when review is requested.
      if (req.reviewer !== undefined)
        throw new HttpError(
          501,
          'not_implemented',
          'Creating tasks with a reviewer is not supported by Hermes',
        )
      const id = `fake-task:${key}`
      if (this.tasks.has(id)) return this.getTask(id)
      const body =
        req.steps === undefined
          ? (req.body ?? '')
          : writeSteps(
              req.body ?? '',
              req.steps.map((text, index) => ({ id: String(index), text, done: false })),
            )
      const task: TaskDetail = {
        id,
        key: `T-${this.tasks.size + 1}`,
        title: req.title,
        body,
        steps: parseSteps(body),
        createdBy: 'you',
        column: 'planned',
        hermesStatus: 'todo',
        assignee: req.assignee ?? null,
        reviewer: req.reviewer ?? null,
        roomId: req.roomId ?? null,
        badge: null,
        progress: null,
        elapsedSec: null,
        note: null,
        updatedAt: this.now(),
        pendingApproval: null,
        dependsOn: req.dependsOn ?? [],
        blocks: [],
        runIds: [],
        activity: [],
      }
      await this.emit({ at: 0, kind: 'task.upserted', data: taskSummary(task) }, undefined, task)
      return this.getTask(id)
    })
  }
  patchTask(id: string, input: Parameters<HermesPort['patchTask']>[1]): Promise<TaskDetail> {
    return this.enqueue(async () => {
      this.requireSink()
      const req = PatchTaskSchema.parse(input)
      if (req.reviewer !== undefined)
        throw new HttpError(501, 'not_implemented', 'Editing reviewer is not supported by Hermes')
      const old = this.tasks.get(id)
      if (!old) throw new HttpError(404, 'not_found', 'Unknown task')
      const body =
        req.steps === undefined
          ? (req.body ?? old.body)
          : writeSteps(req.body ?? old.body, req.steps)
      const task = { ...old, ...req, body, steps: parseSteps(body), updatedAt: this.now() }
      task.progress =
        task.column === 'working' && task.steps.length
          ? task.steps.filter((step) => step.done).length / task.steps.length
          : null
      await this.emit({ at: 0, kind: 'task.upserted', data: taskSummary(task) }, undefined, task)
      return this.getTask(id)
    })
  }

  startRun(input: Parameters<HermesPort['startRun']>[0]): Promise<{ runId: string }> {
    const req = z
      .object({
        agentId: z.string().min(1),
        input: z.string().min(1),
        turnId: z.string().min(1),
        sessionId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        images: z.array(z.string().min(1)).optional(),
      })
      .parse(input)
    return this.enqueue(async () => {
      if (this.db) assertAgentAdmits(this.db.sqlite, input.agentId)
      this.requireSink()
      const existing = this.turns.get(req.turnId)
      if (existing) return { runId: existing }
      if (!this.agents.has(req.agentId)) throw new HttpError(404, 'not_found', 'Unknown agent')
      const runId = `fake-run:${req.turnId}`
      const startedAt = this.scheduler.now()
      const run = { ...exampleRun(req.agentId, runId, this.now()), model: req.model ?? null }
      const base = this.reply(req)
      const seen = req.images?.length ?? 0
      const response = seen
        ? { ...base, text: `${base.text} I can see ${seen} image${seen === 1 ? '' : 's'}.` }
        : base
      await this.requireSink().submit({
        source: 'fake',
        identity: `${this.sessionId}:admitted:${req.turnId}`,
        apply({ sqlite, now }) {
          sqlite
            .prepare(
              `INSERT INTO runs (id, profile, origin, score_turn_id, session_id, status, model, started_at, updated_at)
            VALUES (?, ?, 'score', ?, ?, 'queued', ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .run(runId, req.agentId, req.turnId, req.sessionId ?? null, req.model ?? null, now, now)
          return [
            { type: 'run.updated', data: run },
            ...attachRunMessage(sqlite, req.turnId, runId, now),
          ]
        },
      })
      this.runs.set(runId, run)
      this.turns.set(req.turnId, runId)
      this.schedule(Math.max(0, startedAt + 250 / this.speed - this.scheduler.now()), async () => {
        await this.transitionRun(runId, 'running')
        if (this.runs.get(runId)?.status !== 'running') return
        const chunks = response.text.match(/.{1,24}/gs) ?? []
        const stream = (index: number): void => {
          const chunk = chunks[index]
          const at =
            chunk === undefined ? Math.max(1000, 400 + chunks.length * 150) : 400 + index * 150
          this.schedule(
            Math.max(0, startedAt + at / this.speed - this.scheduler.now()),
            async () => {
              if (this.runs.get(runId)?.status !== 'running') return
              if (chunk !== undefined) {
                await this.requireSink().submit({
                  source: 'fake',
                  identity: `${this.sessionId}:delta:${runId}:${index}`,
                  apply: ({ sqlite, now }) => appendRunMessage(sqlite, runId, chunk, now),
                })
                stream(index + 1)
              } else {
                const complete = async (): Promise<void> => {
                  await this.requireSink().submit({
                    source: 'fake',
                    identity: `${this.sessionId}:tools:${runId}`,
                    apply({ sqlite, now }) {
                      for (const [seq, tool] of response.tools.entries())
                        sqlite
                          .prepare(
                            `INSERT INTO tool_calls
                      (run_id, seq, tool, preview, status, started_at, ended_at) VALUES (?, ?, ?, ?, 'ok', ?, ?) ON CONFLICT DO NOTHING`,
                          )
                          .run(
                            runId,
                            seq,
                            tool,
                            // File tools carry a path so the Chat "Files in play" panel has demo data.
                            tool === 'edit_file'
                              ? JSON.stringify({
                                  path: `src/${seq % 2 ? 'feed-card.css' : 'activity-feed.ts'}`,
                                })
                              : null,
                            now,
                            now,
                          )
                      // Neutral demo frames so Watch has something to replay in fake mode.
                      const frames: DomainEventDraft[] = []
                      for (const [seq, tool] of response.tools.entries()) {
                        const path = `src/${seq % 2 ? 'feed-card.css' : 'activity-feed.ts'}`
                        const draft =
                          tool === 'terminal'
                            ? {
                                surface: 'terminal' as const,
                                payload: {
                                  cwd: 'demo-project',
                                  command: ['pnpm test', 'pnpm lint', 'git status'][seq % 3]!,
                                  output: '3 checks passed',
                                  status: 'ok' as const,
                                },
                                caption: `Ran ${['pnpm test', 'pnpm lint', 'git status'][seq % 3]!}`,
                              }
                            : tool === 'edit_file'
                              ? {
                                  surface: 'editor' as const,
                                  payload: {
                                    path,
                                    diff: `--- ${path}\n+++ ${path}\n@@ -1,1 +1,2 @@\n const demo = true\n+const edited = true\n`,
                                    language: path.endsWith('.ts') ? 'typescript' : 'css',
                                  },
                                  caption: `Edited ${path}`,
                                }
                              : null
                        if (draft)
                          frames.push({
                            type: 'watch.frame',
                            data: recordFrame(sqlite, {
                              agentId: req.agentId,
                              runId,
                              at: now,
                              callKey: null,
                              ...draft,
                            }),
                          })
                      }
                      return frames
                    },
                  })
                  const current = this.runs.get(runId)!
                  this.runs.set(runId, { ...current, toolsUsed: [...new Set(response.tools)] })
                  await this.transitionRun(runId, 'completed')
                }
                // Demo hook: a message that says "ask for approval" makes the run raise one and wait.
                if (!/ask for approval/i.test(req.input.split('\n\nRoom context:')[0] ?? ''))
                  await complete()
                else {
                  await this.requestRunApproval(runId, req.agentId)
                  const deadline = this.scheduler.now() + 600_000
                  const wait = (): void =>
                    this.schedule(250, async () => {
                      if (this.runs.get(runId)?.status !== 'waiting_for_approval') return
                      if (!this.approvalAnswered(runId) && this.scheduler.now() < deadline)
                        return wait()
                      await this.transitionRun(runId, 'running')
                      await complete()
                    })
                  wait()
                }
              }
            },
          )
        }
        stream(0)
      })
      return { runId }
    })
  }

  private async requestRunApproval(runId: string, agentId: string): Promise<void> {
    await this.requireSink().submit({
      source: 'fake',
      identity: `${this.sessionId}:approval:${runId}`,
      apply: ({ sqlite, now }) =>
        requestRunApproval(
          sqlite,
          {
            id: `fake-approval:${runId}`,
            profile: agentId,
            runId,
            requestId: `${runId}:approval`,
            command: 'pnpm add ws@8.18.0',
            description: 'Install the websocket library\nThe run needs it to keep going.',
            choices: ['once', 'session', 'always', 'deny'],
          },
          now,
        ),
    })
    await this.transitionRun(runId, 'waiting_for_approval')
  }

  private approvalAnswered(runId: string): boolean {
    if (!this.db) return true
    const row = readApprovalRow(this.db.sqlite, `fake-approval:${runId}`)
    return !row || row.phase !== 'human_pending'
  }

  private async transitionRun(
    runId: string,
    status: 'running' | 'completed' | 'cancelled' | 'waiting_for_approval',
  ): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running', 'waiting_for_approval'].includes(run.status)) return
    await this.emit({
      at: 0,
      kind: 'run.updated',
      data: {
        ...run,
        status,
        endedAt: status === 'running' || status === 'waiting_for_approval' ? null : this.now(),
      },
    })
  }

  stopRun(req: { agentId: string; runId: string }): Promise<void> {
    return this.enqueue(async () => {
      this.requireSink()
      if (this.runs.get(req.runId)?.agentId !== req.agentId) return
      await this.transitionRun(req.runId, 'cancelled')
    })
  }

  taskAction(request: Parameters<HermesPort['taskAction']>[0]): Promise<{ hermesStatus: string }> {
    return this.enqueue(async () => {
      this.requireSink()
      const req = TaskActionRequestSchema.parse(request)
      const task = this.tasks.get(req.taskId)
      if (!task) throw new HttpError(404, 'not_found', 'Unknown task')
      const oldIds =
        req.action !== 'unblock'
          ? []
          : this.db
            ? openKanbanDenialIds(this.db.sqlite, task.id)
            : [...this.approvals.values()]
                .filter(
                  (approval) =>
                    approval.origin === 'kanban' &&
                    approval.status === 'pending' &&
                    approval.refs.some((ref) => ref.kind === 'task' && ref.taskId === task.id),
                )
                .map((approval) => approval.id)
      if (req.action === 'unblock') {
        if (task.hermesStatus !== 'blocked' && task.hermesStatus !== 'scheduled')
          throw new HttpError(409, 'conflict', 'Task is not blocked', {
            hermesStatus: task.hermesStatus,
          })
        await this.emit({
          at: 0,
          kind: 'task.upserted',
          data: {
            ...task,
            hermesStatus: 'ready',
            column: 'planned',
            badge: null,
            updatedAt: this.now(),
          },
        })
        this.taskOverrides.set(task.id, 'ready')
      } else if (req.action !== 'comment') {
        if (req.action === 'schedule' && !['ready', 'todo'].includes(task.hermesStatus))
          throw new HttpError(409, 'conflict', 'Task is not waiting to start', {
            hermesStatus: task.hermesStatus,
          })
        const status = {
          start: 'ready',
          schedule: 'scheduled',
          block: 'blocked',
          request_review: 'review',
          request_changes: 'ready',
          complete: 'done',
          archive: 'archived',
        }[req.action]
        if (task.hermesStatus === 'archived')
          throw new HttpError(409, 'conflict', 'Task is archived')
        const column =
          status === 'ready' || status === 'scheduled'
            ? 'planned'
            : status === 'blocked'
              ? 'needs_you'
              : status === 'review'
                ? 'in_review'
                : 'done'
        await this.emit({
          at: 0,
          kind: 'task.upserted',
          data: {
            ...taskSummary(task),
            hermesStatus: status,
            column,
            badge: status === 'blocked' ? { kind: 'blocked', label: 'Blocked' } : null,
            progress: null,
            updatedAt: this.now(),
          },
        })
        this.taskOverrides.set(task.id, status)
      }
      if (req.action === 'comment' || req.text)
        await this.emit({
          at: 0,
          kind: 'task.activity',
          data: { taskId: task.id, item: { at: this.now(), agentId: 'you', text: req.text ?? '' } },
        })
      if (oldIds.length)
        await this.requireSink().submit({
          source: 'fake',
          identity: `${this.sessionId}:${this.loop}:command:${this.nextIdentity++}`,
          apply: ({ sqlite, now }) => closeKanbanDenialIds(sqlite, oldIds, now),
        })
      return { hermesStatus: this.tasks.get(task.id)!.hermesStatus }
    })
  }

  deliverDecision(
    req: Parameters<HermesPort['deliverDecision']>[0],
  ): Promise<'applied' | 'not_pending' | 'failed'> {
    return this.enqueue(async () => {
      let approval = this.approvals.get(req.approvalId)
      if (!approval && this.db) {
        const row = readApprovalRow(this.db.sqlite, req.approvalId)
        if (row?.origin === 'kanban') return 'not_pending'
        if (row)
          approval = {
            id: row.id,
            status: row.status,
            phase: row.phase,
            origin: row.origin,
            agentId: row.profile,
            choices: row.choices,
            decision: null,
            actionable: true,
            linkedTo: null,
            title: row.description,
            command: row.command,
            cwd: null,
            description: row.description,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            delivery: 'none',
            blocking: null,
            refs: [],
          }
      }
      DecisionDeliveryRequestSchema.parse(req)
      if (!approval || !approval.actionable || approval.status !== 'pending' || approval.decision)
        return 'not_pending'
      if (!approval.choices.includes(req.choice)) return 'failed'
      try {
        await this.emit({
          at: 0,
          kind: 'approval.updated',
          data: {
            ...approval,
            phase: 'decided',
            status: req.choice === 'deny' ? 'denied' : 'approved',
            decision: { choice: req.choice, by: 'elsewhere', at: this.now() },
            delivery: 'applied',
          },
        })
        return 'applied'
      } catch {
        return 'failed'
      }
    })
  }
}

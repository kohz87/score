import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import {
  attachRunMessage,
  appendRunMessage,
  completeRunMessage,
} from '../../domain/message-runs.ts'
import { updateProjectedAgent } from '../../domain/agents.ts'
import {
  recordKanbanDenial,
  closeKanbanDenialIds,
  openKanbanDenialIds,
} from '../../domain/kanban-denials.ts'
import { requestRunApproval, respondRunApproval } from '../../domain/approvals.ts'
import { insertRoom, roomChanged, storeMessage, updateMessage } from '../../domain/rooms.ts'
import { approvalDraft, patchApproval, readApprovalRow } from '../../domain/approval-store.ts'
import type { AgentSummary, Approval, RunSummary, TaskDetail } from '@score/contract'
import { parseSteps, writeSteps } from '../../domain/steps.ts'
import {
  projectTask,
  readProjectedTask,
  summaryDetail,
  taskWithApproval,
  taskSummary,
} from '../../domain/tasks.ts'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft, Observation } from '../../hub/ingest.ts'
import {
  DecisionDeliveryRequestSchema,
  TaskActionRequestSchema,
  CreateTaskSchema,
  PatchTaskSchema,
  TaskFilterSchema,
  matchesTask,
  type HermesPort,
  type HermesPortDeps,
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
        projectTask(
          sqlite,
          detail ?? {
            ...(readProjectedTask(sqlite, step.data.id) ?? summaryDetail(step.data)),
            ...step.data,
          },
        )
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
        if (!exists && !events.some((event) => event.type === 'room.upserted'))
          events.push(...roomChanged(sqlite, message.roomId, now))
        return events
      }
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
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status))
          return [
            structuredClone(draft) as DomainEventDraft,
            ...completeRunMessage(sqlite, run.id, now, { handoffs: run.status === 'completed' }),
          ]
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
        if (step.data.decision)
          return respondRunApproval(
            sqlite,
            row.profile,
            row.session_key,
            row.request_id!,
            step.data.decision.choice,
            step.data.decision.at,
          )
        patchApproval(sqlite, row.id, { blocking: step.data.blocking }, now)
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
  ) {
    if (!Number.isFinite(speed) || speed <= 0)
      throw new Error('Fake speed must be positive and finite')
    this.db = deps.db
    this.scheduler = deps.scheduler ?? realScheduler
    this.onError = deps.onError ?? ((error) => console.error('Fake observation failed', error))
    this.resetState()
  }

  private resetState(): void {
    this.agents = new Map(exampleAgents().map((agent) => [agent.id, agent]))
    this.approvals.clear()
    this.tasks.clear()
    this.taskOverrides.clear()
    this.runs.clear()
    this.turns.clear()
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

  async listAgentDetails(): Promise<AgentDetail[]> {
    return (await this.listAgents()).map((agent) =>
      AgentDetailSchema.parse({
        ...agent,
        tagline: agent.role,
        personality: { excerpt: `I am ${agent.id}. ${agent.role}.`, source: 'SOUL.md' },
        reportsTo: agent.id === 'lead' ? null : 'lead',
        worksIn: null,
        rulesFile: 'AGENTS.md',
        model: { ...agent.model, via: 'Demo', fallback: null },
        skills: [{ name: 'collaboration', enabled: true }],
        memory: [],
        tools: [],
        helpersMax: null,
        routines: [],
        channels: [],
        permissions: [],
      }),
    )
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
      })
      .parse(input)
    return this.enqueue(async () => {
      this.requireSink()
      const existing = this.turns.get(req.turnId)
      if (existing) return { runId: existing }
      if (!this.agents.has(req.agentId)) throw new HttpError(404, 'not_found', 'Unknown agent')
      const runId = `fake-run:${req.turnId}`
      const startedAt = this.scheduler.now()
      const run = { ...exampleRun(req.agentId, runId, this.now()), model: req.model ?? null }
      const response = this.reply(req)
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
                await this.requireSink().submit({
                  source: 'fake',
                  identity: `${this.sessionId}:tools:${runId}`,
                  apply({ sqlite, now }) {
                    for (const [seq, tool] of response.tools.entries())
                      sqlite
                        .prepare(
                          `INSERT INTO tool_calls
                    (run_id, seq, tool, status, started_at, ended_at) VALUES (?, ?, ?, 'ok', ?, ?) ON CONFLICT DO NOTHING`,
                        )
                        .run(runId, seq, tool, now, now)
                    return []
                  },
                })
                const current = this.runs.get(runId)!
                this.runs.set(runId, { ...current, toolsUsed: [...new Set(response.tools)] })
                await this.transitionRun(runId, 'completed')
              }
            },
          )
        }
        stream(0)
      })
      return { runId }
    })
  }

  private async transitionRun(
    runId: string,
    status: 'running' | 'completed' | 'cancelled',
  ): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || !['queued', 'running', 'waiting_for_approval'].includes(run.status)) return
    await this.emit({
      at: 0,
      kind: 'run.updated',
      data: { ...run, status, endedAt: status === 'running' ? null : this.now() },
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
        if (task.hermesStatus !== 'blocked')
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
        const status = {
          start: 'ready',
          block: 'blocked',
          request_review: 'review',
          request_changes: 'ready',
          complete: 'done',
          archive: 'archived',
        }[req.action]
        if (task.hermesStatus === 'archived')
          throw new HttpError(409, 'conflict', 'Task is archived')
        const column =
          status === 'ready'
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

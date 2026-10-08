import {
  recordKanbanDenial,
  closeKanbanDenialIds,
  openKanbanDenialIds,
} from '../../domain/kanban-denials.ts'
import { requestRunApproval, respondRunApproval } from '../../domain/approvals.ts'
import { insertRoom, roomChanged, storeMessage, updateMessage } from '../../domain/rooms.ts'
import { approvalDraft, patchApproval, readApprovalRow } from '../../domain/approval-store.ts'
import type { AgentSummary, Approval, RunSummary, TaskSummary } from '@score/contract'
import { createHash, randomUUID } from 'node:crypto'
import { HttpError } from '../../errors.ts'
import type { Observation } from '../../hub/ingest.ts'
import {
  DecisionDeliveryRequestSchema,
  TaskActionRequestSchema,
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
): Observation {
  const draft = structuredClone({ type: step.kind, data: step.data })
  return {
    source: 'fake',
    identity,
    apply({ sqlite, now }) {
      if (suppressed) return []
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
            `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
          )
          .run(run.id, run.agentId, run.origin, run.status, run.startedAt, run.endedAt, now)
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
          { origin: approval.origin, blocking: approval.blocking },
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
  private readonly tasks = new Map<string, TaskSummary>()
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
  ): Promise<void> {
    // Delayed script steps cannot undo commands delivered while the scenario was playing.
    const suppressed = Boolean(
      (step.kind === 'task.upserted' &&
        this.taskOverrides.has(step.data.id) &&
        step.data.hermesStatus !== this.taskOverrides.get(step.data.id)) ||
      (step.kind === 'approval.updated' && this.approvals.get(step.data.id)?.decision) ||
      (step.kind === 'run.updated' &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          this.runs.get(step.data.id)?.status ?? '',
        )),
    )
    await this.requireSink().submit(
      stepToObservation(step, `${this.sessionId}:${index}`, suppressed),
    )
    if (suppressed) return
    switch (step.kind) {
      case 'task.upserted':
        this.tasks.set(step.data.id, {
          ...structuredClone(step.data),
          hermesStatus: this.taskOverrides.get(step.data.id) ?? step.data.hermesStatus,
        })
        break
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

  startRun(req: { agentId: string; input: string; turnId: string }): Promise<{ runId: string }> {
    return this.enqueue(async () => {
      this.requireSink()
      const existing = this.turns.get(req.turnId)
      if (existing) return { runId: existing }
      if (!this.agents.has(req.agentId)) throw new HttpError(404, 'not_found', 'Unknown agent')
      const runId = `fake-run:${req.turnId}`
      const startedAt = this.scheduler.now()
      const run = exampleRun(req.agentId, runId, this.now())
      await this.emit({ at: 0, kind: 'run.updated', data: run })
      this.turns.set(req.turnId, runId)
      this.schedule(Math.max(0, startedAt + 250 / this.speed - this.scheduler.now()), async () => {
        await this.transitionRun(runId, 'running')
        if (this.runs.get(runId)?.status !== 'running') return
        const remaining = Math.max(0, startedAt + 1000 / this.speed - this.scheduler.now())
        this.schedule(remaining, () => this.transitionRun(runId, 'completed'))
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
      }
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

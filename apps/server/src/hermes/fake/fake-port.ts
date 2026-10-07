import type { AgentSummary, Approval, ApprovalChoice, RunSummary } from '@score/contract'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../errors.ts'
import type { Observation } from '../../hub/ingest.ts'
import type { HermesPort, HermesPortDeps, ObservationSink, Scheduler } from '../port.ts'
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

// Projection writes can be added here when the corresponding tables arrive.
export function stepToObservation(
  step: ScenarioStep,
  identity: string,
  suppressed = false,
): Observation {
  const draft = structuredClone({ type: step.kind, data: step.data })
  return {
    source: 'fake',
    identity,
    apply: () => (suppressed ? [] : ([structuredClone(draft)] as ReturnType<Observation['apply']>)),
  }
}

export class FakePort implements HermesPort {
  readonly mode = 'fake'
  private readonly scheduler: Scheduler
  private readonly onError: (error: unknown) => void
  private readonly timers = new Set<unknown>()
  private readonly approvals = new Map<string, Approval>()
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
    this.scheduler = deps.scheduler ?? realScheduler
    this.onError = deps.onError ?? ((error) => console.error('Fake observation failed', error))
    this.resetState()
  }

  private resetState(): void {
    this.agents = new Map(exampleAgents().map((agent) => [agent.id, agent]))
    this.approvals.clear()
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

  deliverDecision(req: {
    approvalId: string
    choice: ApprovalChoice
  }): Promise<'applied' | 'not_pending' | 'failed'> {
    return this.enqueue(async () => {
      const approval = this.approvals.get(req.approvalId)
      if (!approval || approval.status !== 'pending' || approval.decision) return 'not_pending'
      if (!approval.choices.includes(req.choice)) return 'failed'
      try {
        await this.emit({
          at: 0,
          kind: 'approval.updated',
          data: {
            ...approval,
            phase: 'decided',
            status: req.choice === 'deny' ? 'denied' : 'approved',
            decision: { choice: req.choice, by: 'you', at: this.now() },
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

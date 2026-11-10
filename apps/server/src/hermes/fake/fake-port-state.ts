import { randomUUID } from 'node:crypto'
import {
  AgentDetailSchema,
  type AgentSummary,
  type Approval,
  type MemoryItem,
  type ModelSettings,
  type PluginItem,
  type ProfileStepName,
  type RoutineSummary,
  type RunSummary,
  type SkillItem,
  type TaskDetail,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { summaryDetail } from '../../domain/tasks.ts'
import type { AgentTool } from '../agent-tabs.ts'
import type { ApprovalConfig } from '../approvals.ts'
import type { HermesPort, HermesPortDeps, ObservationSink, Scheduler } from '../port.ts'
import { FakeWorkspaces } from './fake-workspace.ts'
import { memoryId, realScheduler } from './fake-port-fixtures.ts'
import { stepToObservation } from './fake-port-observations.ts'
import { createScenario, exampleAgents, fakeStatus, type ScenarioStep } from './scenario.ts'

export abstract class FakePortState {
  readonly mode = 'fake'
  protected readonly db: HermesPortDeps['db']
  protected readonly scheduler: Scheduler
  protected readonly onError: (error: unknown) => void
  protected readonly timers = new Set<unknown>()
  protected readonly approvals = new Map<string, Approval>()
  protected readonly tasks = new Map<string, TaskDetail>()
  protected readonly taskOverrides = new Map<string, string>()
  protected readonly runs = new Map<string, RunSummary>()
  protected readonly turns = new Map<string, string>()
  protected agents = new Map<string, AgentSummary>()
  protected readonly routines = new Map<string, RoutineSummary>()
  protected readonly routineOutputs = new Map<
    string,
    { file: string; at: string; text: string | null }[]
  >()
  protected readonly routineKeys = new Map<string, string>()
  protected routineCount = 0
  protected readonly files = new Map<string, string>()
  protected readonly models = new Map<string, { model: AgentSummary['model']; via: string }>()
  protected readonly modelSettings = new Map<string, ModelSettings>()
  protected readonly skills = new Map<string, SkillItem[]>()
  protected readonly memory = new Map<string, MemoryItem[]>()
  protected readonly tools = new Map<string, AgentTool[]>()
  protected readonly plugins = new Map<string, PluginItem[]>()
  protected readonly approvalConfigs = new Map<string, ApprovalConfig>()
  protected readonly profileIdentities = new Map<string, string>()
  protected readonly profileSteps = new Map<string, Set<ProfileStepName>>()
  protected sink: ObservationSink | undefined
  protected sessionId = ''
  protected nextIdentity = 0
  protected loop = 0
  protected tail: Promise<void> = Promise.resolve()
  protected stopping: Promise<void> | undefined
  protected readonly workspaces = new FakeWorkspaces()
  /** Demo questions (decision 128) waiting for the person: run id → the prompt and what continues the reply. */
  protected readonly questions = new Map<
    string,
    { promptId: string; resolve: (answer: string | null) => void }
  >()

  constructor(
    protected readonly speed = 1,
    deps: HermesPortDeps = {},
    protected readonly looping = true,
    protected readonly reply: (req: Parameters<HermesPort['startRun']>[0]) => {
      text: string
      tools: string[]
    } = () => ({
      text: 'I have reviewed the room context. The work is ready for the next step.',
      tools: ['terminal', 'terminal', 'terminal', 'edit_file', 'edit_file'],
    }),
    // Dev and e2e only: a believable month of finished work so Reports has something to show.
    protected readonly seedReportHistory = false,
  ) {
    if (!Number.isFinite(speed) || speed <= 0)
      throw new Error('Fake speed must be positive and finite')
    this.db = deps.db
    this.scheduler = deps.scheduler ?? realScheduler
    this.onError = deps.onError ?? ((error) => console.error('Fake observation failed', error))
    this.resetState()
  }

  protected resetState(): void {
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
    this.routineOutputs.clear()
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

  protected scheduleScenario(): void {
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
    // Runs waiting for an answer never continue.
    for (const waiting of this.questions.values()) waiting.resolve(null)
    this.questions.clear()
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

  protected agentOrThrow(agentId: string): AgentSummary {
    const agent = this.agents.get(agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return agent
  }

  protected enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  protected schedule(delayMs: number, work: () => Promise<void>): void {
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

  protected requireSink(): ObservationSink {
    if (!this.sink)
      throw new HttpError(503, 'hermes_unavailable', 'The test adapter isn’t started.')
    return this.sink
  }

  protected async emit(
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

  protected now(): string {
    return new Date(this.scheduler.now()).toISOString()
  }
}

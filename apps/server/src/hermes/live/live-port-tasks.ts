import { z } from 'zod'
import {
  projectedTasks,
  readProjectedTask,
  taskSummary,
  taskWithApproval,
} from '../../domain/tasks.ts'
import { HttpError } from '../../errors.ts'
import {
  ApprovalDeliveryError,
  DecisionDeliveryRequestSchema,
  TaskFilterSchema,
  matchesTask,
  type HermesPort,
} from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { assertThawed } from './freeze.ts'
import { HermesHttpError } from './gateway.ts'
import { readJourneyFacts } from './journey-facts.ts'
import { listOutsideSessions, readOutsideSession } from './outside-sessions.ts'
import { readProfileSessionCosts, readReportFacts } from './report-facts.ts'
import { taskAction, taskReader } from './task-actions.ts'
import { createTask, patchTask } from './task-writes.ts'
import { readRun } from './translate.ts'
import type { LivePortRuntime } from './live-port-runtime.ts'

export const taskMethods = {
  async taskAction(
    this: LivePortRuntime,
    req: Parameters<HermesPort['taskAction']>[0],
  ): Promise<{ hermesStatus: string }> {
    // Actions that make Hermes pick a task up (start, unblock, schedule, ask for review or changes) start agent work.
    if (['start', 'unblock', 'schedule', 'request_review', 'request_changes'].includes(req.action))
      assertThawed(this.options.frozen)
    const { gateway } = this.requireStarted()
    const result = await taskAction(req, {
      readTask: taskReader(this.options.hermesHome),
      withoutCredential: (profile, text) => {
        try {
          return gateway.withoutCredential(profile, text)
        } catch (error) {
          if (error instanceof CredentialsUnavailable) return text
          throw error
        }
      },
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
    await this.refreshTasks()
    return result
  },
  async reportFacts(this: LivePortRuntime, req: Parameters<HermesPort['reportFacts']>[0]) {
    return readReportFacts(req, this.options.hermesHome)
  },
  async journeyFacts(this: LivePortRuntime, req: Parameters<HermesPort['journeyFacts']>[0]) {
    return readJourneyFacts(
      req,
      (profile) => this.profiles.profileHome(profile),
      this.options.hermesHome,
    )
  },
  async listOutsideSessions(this: LivePortRuntime, agentIds: string[]) {
    return listOutsideSessions(agentIds, this.options.hermesHome)
  },
  async readOutsideSession(this: LivePortRuntime, agentId: string, sessionId: string) {
    return readOutsideSession(agentId, sessionId, this.options.hermesHome)
  },
  // Hermes' /v1/runs takes `session_id` and loads that session's history (api_server_runs.py); Score already passes
  // one on every run. A gateway without the run API cannot start Score runs at all.
  sessionContinuation(this: LivePortRuntime): 'same_session' | 'new_session' | 'unknown' {
    // An unreachable gateway says nothing about what it supports: never turn an outage into a stored fallback.
    return this.current.hermes.reachable && this.current.hermes.apiServer
      ? 'same_session'
      : 'unknown'
  },
  async sessionCosts(this: LivePortRuntime, req: { sinceMs: number; agentIds: string[] }) {
    return readProfileSessionCosts(req, this.options.hermesHome)
  },
  async listTasks(this: LivePortRuntime, filter: Parameters<HermesPort['listTasks']>[0] = {}) {
    const { db } = this.requireStarted()
    const parsed = TaskFilterSchema.parse(filter)
    await this.refreshTasks()
    return db.read((sqlite) =>
      projectedTasks(sqlite)
        .filter((task) => matchesTask(task, parsed))
        .map(taskSummary),
    )
  },
  async getTask(this: LivePortRuntime, id: string) {
    const { db } = this.requireStarted()
    z.string().min(1).max(256).parse(id)
    await this.refreshTasks()
    return db.read((sqlite) => {
      const task = readProjectedTask(sqlite, id)
      if (!task) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
      return taskWithApproval(sqlite, task)
    })
  },
  async createTask(
    this: LivePortRuntime,
    req: Parameters<HermesPort['createTask']>[0],
    key: string,
  ) {
    const { db } = this.requireStarted()
    return createTask(req, key, { db, ...this.writeDeps() })
  },
  async patchTask(this: LivePortRuntime, id: string, req: Parameters<HermesPort['patchTask']>[1]) {
    this.requireStarted()
    return patchTask(id, req, this.writeDeps())
  },
  writeDeps(this: LivePortRuntime) {
    return {
      getTask: (id: string) => this.getTask(id),
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    }
  },
  async refreshTasks(this: LivePortRuntime): Promise<void> {
    try {
      await this.tasks!.poll()
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the tasks from Hermes.')
    }
  },
  async answerQuestion(this: LivePortRuntime, req: Parameters<HermesPort['answerQuestion']>[0]) {
    assertThawed(this.options.frozen)
    const { db, gateway } = this.requireStarted()
    const row = readRun(db.sqlite, req.runId)
    if (row.profile !== req.agentId || row.origin !== 'score')
      throw new HttpError(409, 'conflict', 'This question isn’t on a run Score started.')
    return gateway.submitClarify(
      req.agentId,
      { runId: req.runId, promptId: req.promptId, generation: req.generation, answer: req.answer },
      row.credential_generation ?? undefined,
    )
  },
  async deliverDecision(
    this: LivePortRuntime,
    req: Parameters<HermesPort['deliverDecision']>[0],
  ): Promise<'applied' | 'not_pending' | 'failed'> {
    try {
      const hold = this.options.frozen?.() ?? null
      if (hold !== null) throw new ApprovalDeliveryError('execution_frozen', false, true)
      const { db, gateway } = this.requireStarted()
      const target = DecisionDeliveryRequestSchema.extend({ runId: z.string().min(1) }).parse(req)
      const row = readRun(db.sqlite, target.runId)
      if (
        row.profile !== target.profile ||
        row.origin !== 'score' ||
        row.credential_generation === null
      )
        throw new ApprovalDeliveryError('invalid_target', false, false)
      return await gateway.submitApproval(target.profile, target, row.credential_generation)
    } catch (error) {
      if (error instanceof ApprovalDeliveryError) throw error
      if (error instanceof CredentialsUnavailable)
        throw new ApprovalDeliveryError('credentials_unavailable', false, false)
      if (error instanceof HermesHttpError) {
        const retryable =
          error.status === 0 || error.status >= 500 || [408, 429].includes(error.status)
        throw new ApprovalDeliveryError(
          error.code,
          retryable || error.status === 200 ? error.maybeApplied : false,
          retryable,
        )
      }
      throw new ApprovalDeliveryError('invalid_target', false, false)
    }
  },
}

export type TaskMethods = typeof taskMethods

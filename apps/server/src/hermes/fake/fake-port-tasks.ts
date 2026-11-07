import type { TaskDetail } from '@score/contract'
import { closeKanbanDenialIds, openKanbanDenialIds } from '../../domain/kanban-denials.ts'
import { parseSteps, writeSteps } from '../../domain/steps.ts'
import { taskSummary, taskWithApproval } from '../../domain/tasks.ts'
import { HttpError } from '../../errors.ts'
import {
  CreateTaskSchema,
  PatchTaskSchema,
  TaskActionRequestSchema,
  TaskFilterSchema,
  matchesTask,
  type HermesPort,
} from '../port.ts'
import { FakePortAgents } from './fake-port-agents.ts'

export abstract class FakePortTasks extends FakePortAgents {
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
    if (!task) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
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
          'Hermes doesn’t support creating tasks with a reviewer.',
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
        throw new HttpError(
          501,
          'not_implemented',
          'Hermes doesn’t support changing a task’s reviewer.',
        )
      const old = this.tasks.get(id)
      if (!old) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
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

  taskAction(request: Parameters<HermesPort['taskAction']>[0]): Promise<{ hermesStatus: string }> {
    return this.enqueue(async () => {
      this.requireSink()
      const req = TaskActionRequestSchema.parse(request)
      const task = this.tasks.get(req.taskId)
      if (!task) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
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
          throw new HttpError(409, 'conflict', 'This task isn’t blocked.', {
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
          throw new HttpError(409, 'conflict', 'This task isn’t waiting to start.', {
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
          throw new HttpError(409, 'conflict', 'This task is archived.')
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
          data: {
            taskId: task.id,
            item: { at: this.now(), agentId: req.author ?? 'you', text: req.text ?? '' },
          },
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
}

import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { TaskActionRequestSchema } from '../port.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { readTasks, type Task } from './kanban.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { openReadOnly } from './sqlite.ts'

export const TaskIdSchema = z.string().regex(/^t_[a-zA-Z0-9_-]{1,128}$/)

export function taskReader(hermesHome?: string): (taskId: string) => Task | undefined {
  return (taskId) => {
    const db = openReadOnly(hermesPaths(resolveHermesHome(hermesHome)).kanbanDb)
    try {
      const batch = readTasks(db, [taskId])
      if (batch.malformed) throw new HttpError(502, 'hermes_unavailable', 'Task data unavailable')
      return batch.rows[0]
    } finally {
      db.close()
    }
  }
}
export async function taskAction(
  request: z.infer<typeof TaskActionRequestSchema>,
  deps: {
    readTask: (id: string) => Task | undefined
    withoutCredential: (profile: string, text: string) => string
    runner?: HermesRunner
    hermesHome?: string
  },
): Promise<{ hermesStatus: string }> {
  const req = TaskActionRequestSchema.parse(request)
  TaskIdSchema.parse(req.taskId)
  function read(): Task {
    try {
      const task = deps.readTask(req.taskId)
      if (!task) throw new HttpError(404, 'not_found', 'Unknown task')
      return task
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'hermes_unavailable', 'Task data unavailable')
    }
  }
  const task = read()
  if (req.action === 'unblock' && task.status !== 'blocked')
    throw new HttpError(409, 'conflict', 'Task is not blocked', { hermesStatus: task.status })
  let text: string
  try {
    text = deps.withoutCredential(
      task.assignee ?? 'default',
      req.text ?? (req.action === 'unblock' ? 'Unblocked in Score' : ''),
    )
  } catch {
    throw new HttpError(502, 'hermes_unavailable', 'Task credentials unavailable')
  }
  const args = actionArgs(req.action, req.taskId, text)
  const result = await (deps.runner ?? runHermes)(args, {
    timeoutMs: 10_000,
    ...(deps.hermesHome ? { hermesHome: deps.hermesHome } : {}),
  }).catch(() => ({ exitCode: -1 }))
  const current = read()
  if (result.exitCode !== 0) {
    if (req.action === 'unblock' && current.status !== 'blocked')
      throw new HttpError(409, 'conflict', 'Task state changed', { hermesStatus: current.status })
    throw new HttpError(
      result.exitCode < 0 ? 502 : 409,
      result.exitCode < 0 ? 'hermes_unavailable' : 'conflict',
      'Hermes rejected the task action',
      { hermesStatus: current.status },
    )
  }
  return { hermesStatus: current.status }
}

function actionArgs(
  action: z.infer<typeof TaskActionRequestSchema>['action'],
  taskId: string,
  text: string,
): string[] {
  switch (action) {
    case 'comment':
      return ['kanban', 'comment', '--author', 'score', '--', taskId, text]
    case 'unblock':
      return ['kanban', 'unblock', `--reason=${text}`, '--', taskId]
    case 'start':
      return ['kanban', 'promote', '--', taskId, text || 'Started in Score']
    case 'block':
      return ['kanban', 'block', '--', taskId, text || 'Blocked in Score']
    case 'request_review':
      return ['kanban', 'request-review', ...(text ? [`--summary=${text}`] : []), '--', taskId]
    case 'request_changes':
      return ['kanban', 'request-changes', '--', taskId, text || 'Changes requested in Score']
    case 'complete':
      return ['kanban', 'complete', ...(text ? [`--result=${text}`] : []), '--', taskId]
    case 'archive':
      return ['kanban', 'archive', '--', taskId]
  }
}

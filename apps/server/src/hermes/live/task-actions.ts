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
    text = deps.withoutCredential(task.assignee ?? 'default', req.text ?? 'Unblocked in Score')
  } catch {
    throw new HttpError(502, 'hermes_unavailable', 'Task credentials unavailable')
  }
  const args =
    req.action === 'unblock'
      ? // `--reason=<text>` and `--` keep user text from being parsed as an option (e.g. a note starting with "-").
        ['kanban', 'unblock', `--reason=${text}`, '--', req.taskId]
      : ['kanban', 'comment', '--author', 'score', '--', req.taskId, text]
  const result = await (deps.runner ?? runHermes)(args, {
    timeoutMs: 10_000,
    ...(deps.hermesHome ? { hermesHome: deps.hermesHome } : {}),
  }).catch(() => ({ exitCode: -1 }))
  const current = read()
  if (result.exitCode !== 0) {
    if (req.action === 'unblock' && current.status !== 'blocked')
      throw new HttpError(409, 'conflict', 'Task state changed', { hermesStatus: current.status })
    throw new HttpError(502, 'hermes_unavailable', 'Hermes rejected the task action')
  }
  return { hermesStatus: current.status }
}

import type { TaskDetail } from '@score/contract'
import { stampHistoryId } from '../../domain/ownership.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSteps, writeSteps } from '../../domain/steps.ts'
import { redact } from '../../redact.ts'
import { HttpError } from '../../errors.ts'
import { withKeyedLock } from '../../keyed-lock.ts'
import type { ScoreDb } from '../../db/index.ts'
import { CreateTaskSchema, PatchTaskSchema } from '../port.ts'
import { runHermes, type HermesRunner } from './cli.ts'
import { ProfileNameSchema } from './paths.ts'
import { TaskIdSchema, taskReader } from './task-actions.ts'

interface WriteDeps {
  runner?: HermesRunner
  hermesHome?: string
  getTask(id: string): Promise<TaskDetail>
}
async function execute(args: string[], deps: WriteDeps) {
  const result = await (deps.runner ?? runHermes)(args, {
    timeoutMs: 10000,
    ...(args.slice(0, 3).join(' ') === 'kanban create --json' ? { captureTaskCreate: true } : {}),
    ...(deps.hermesHome ? { hermesHome: deps.hermesHome } : {}),
  }).catch((): { exitCode: number; stdout?: string } => ({ exitCode: -1 }))
  if (result.exitCode !== 0)
    throw new HttpError(
      result.exitCode < 0 ? 502 : 409,
      result.exitCode < 0 ? 'hermes_unavailable' : 'conflict',
      'Hermes didn’t accept the task change.',
    )
  return result
}

export function createTask(
  input: z.infer<typeof CreateTaskSchema>,
  key: string,
  deps: WriteDeps & { db: ScoreDb },
): Promise<TaskDetail> {
  // Hermes checks the key before its write transaction, so concurrent callers must not both reach the CLI.
  return withKeyedLock(`task-create:${key}`, () => createTaskUnlocked(input, key, deps))
}

async function createTaskUnlocked(
  input: z.infer<typeof CreateTaskSchema>,
  key: string,
  deps: WriteDeps & { db: ScoreDb },
): Promise<TaskDetail> {
  const req = CreateTaskSchema.parse(input)
  z.string()
    .regex(/^[\x21-\x7e]{1,256}$/)
    .parse(key)
  // Hermes names a reviewer only when review is requested (`kanban request-review --reviewer`), not at creation.
  if (req.reviewer !== undefined)
    throw new HttpError(
      501,
      'not_implemented',
      'Hermes doesn’t support creating tasks with a reviewer.',
    )
  if (
    req.roomId !== undefined &&
    !deps.db.sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(req.roomId)
  )
    throw new HttpError(400, 'bad_request', 'Couldn’t find that room.')
  if (req.assignee) ProfileNameSchema.parse(req.assignee)
  for (const parent of req.dependsOn ?? []) TaskIdSchema.parse(parent)
  const body =
    req.steps === undefined
      ? (req.body ?? '')
      : writeSteps(
          req.body ?? '',
          req.steps.map((text, index) => ({ id: String(index), text, done: false })),
        )
  const args = [
    'kanban',
    'create',
    '--json',
    `--idempotency-key=${key}`,
    '--created-by',
    'score',
    `--body=${body}`,
    ...(req.assignee ? [`--assignee=${req.assignee}`] : []),
    ...(req.dependsOn ?? []).map((id) => `--parent=${id}`),
    '--',
    req.title,
  ]
  z.string().max(32000).parse(body)
  const intentId = `task-create:${key}`
  const payload = JSON.stringify({
    requestHash: createHash('sha256')
      .update(JSON.stringify(req.roomId === undefined ? args : [args, req.roomId]))
      .digest('hex'),
  })
  const now = new Date().toISOString()
  // Persist intent before the external create; its key also deduplicates at the upstream boundary.
  const existing = deps.db.sqlite
    .prepare('SELECT state, result, payload FROM command_intents WHERE id = ?')
    .get(intentId)
  if (existing) {
    const row = z
      .object({ state: z.string(), result: z.string().nullable(), payload: z.string() })
      .parse(existing)
    if (row.payload !== payload)
      throw new HttpError(
        409,
        'idempotency_conflict',
        'That request was already used for a different task.',
      )
    if (row.state === 'accepted' && row.result) return deps.getTask(TaskIdSchema.parse(row.result))
    // Not accepted: the earlier attempt timed out, failed or died mid-way, and Hermes may or may not have created
    // the task. Asking again with the same --idempotency-key returns that task if it exists (kanban_db
    // create_task) and creates it otherwise, so the retry can never duplicate it.
    deps.db.sqlite
      .prepare("UPDATE command_intents SET state = 'pending', updated_at = ? WHERE id = ?")
      .run(now, intentId)
  } else {
    deps.db.tx((sqlite) =>
      sqlite
        .prepare(
          `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
    VALUES (?, 'task-create', ?, ?, 'pending', ?, ?)`,
        )
        .run(intentId, intentId, payload, now, now),
    )
  }
  try {
    const result = await execute(args, deps)
    let id: string
    try {
      id = z.object({ id: TaskIdSchema }).parse(JSON.parse(result.stdout ?? '')).id
    } catch {
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Hermes returned something Score couldn’t read after creating the task.',
      )
    }
    deps.db.tx((sqlite) => {
      const at = new Date().toISOString()
      sqlite
        .prepare(
          "UPDATE command_intents SET state = 'accepted', result = ?, attempts = 1, updated_at = ? WHERE id = ?",
        )
        .run(id, at, intentId)
      if (req.roomId !== undefined)
        sqlite
          .prepare(
            'INSERT OR REPLACE INTO task_rooms (task_id, room_id, created_at, history_id) VALUES (?, ?, ?, ?)',
          )
          .run(id, req.roomId, at, stampHistoryId(sqlite))
    })
    return await deps.getTask(id)
  } catch (error) {
    deps.db.tx((sqlite) =>
      sqlite
        .prepare(
          "UPDATE command_intents SET state = ?, attempts = 1, updated_at = ? WHERE id = ? AND state != 'accepted'",
        )
        .run(
          error instanceof HttpError && error.status === 409 ? 'failed' : 'unknown',
          new Date().toISOString(),
          intentId,
        ),
    )
    throw error
  }
}

export async function patchTask(
  id: string,
  input: z.infer<typeof PatchTaskSchema>,
  deps: WriteDeps,
): Promise<TaskDetail> {
  const req = PatchTaskSchema.parse(input)
  TaskIdSchema.parse(id)
  await deps.getTask(id)
  if (req.reviewer !== undefined)
    throw new HttpError(
      501,
      'not_implemented',
      'The Hermes command line doesn’t support changing a task’s reviewer.',
    )
  if (req.assignee) ProfileNameSchema.parse(req.assignee)
  let body = req.body
  if (req.steps !== undefined) {
    // Edit the original body, never the redacted projection: toggling a step must preserve other bytes.
    const original = taskReader(deps.hermesHome)(id)
    if (!original) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
    const originalBody = req.body ?? original.body ?? ''
    const originalSteps = parseSteps(originalBody)
    const steps = req.steps.map((step) => {
      const old = originalSteps.find((old) => old.id === step.id)
      return old && redact(old.text) === step.text ? { ...step, text: old.text } : step
    })
    body = writeSteps(originalBody, steps)
  }
  if (body !== undefined) z.string().max(32000).parse(body)
  // These are separate upstream verbs; validate every field before the first mutation.
  if (req.title !== undefined || body !== undefined) {
    await execute(
      [
        'kanban',
        'edit',
        ...(req.title !== undefined ? [`--title=${req.title}`] : []),
        ...(body !== undefined ? [`--body=${body}`] : []),
        '--',
        id,
      ],
      deps,
    )
  }
  if (req.assignee !== undefined) await execute(['kanban', 'assign', '--', id, req.assignee], deps)
  return deps.getTask(id)
}

import { randomUUID } from 'node:crypto'
import type { Message, PlanStartResponse } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { emitBriefChange, linkTasks, readBriefRow } from '../domain/briefs.ts'
import { orderedPlanSteps } from '../domain/plan.ts'
import { messageFromRow, storeMessage } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { withKeyedLock } from '../keyed-lock.ts'
import { redact } from '../redact.ts'

const StepsSchema = z.array(
  z.object({ index: z.int().nonnegative(), agentId: z.string(), title: z.string() }),
)
const RunRow = z.object({
  message_id: z.string(),
  room_id: z.string(),
  brief_id: z.string(),
  steps: z.string().transform((text) => StepsSchema.parse(JSON.parse(text))),
  task_ids: z.string().transform((text) => z.array(z.string()).parse(JSON.parse(text))),
  state: z.enum(['running', 'done', 'failed']),
})
type PlanRun = z.infer<typeof RunRow>

export interface PlanStarter {
  /** Records the start (message, brief, steps) and runs it; a repeated start resumes where the last one stopped. */
  start(roomId: string, messageId: string): Promise<PlanStartResponse>
  /** Startup: finishes plan starts a crash interrupted, or marks them failed with a notice in the room. */
  recover(): Promise<number>
}

const lockKey = (messageId: string) => `plan-start:${messageId}`

/**
 * Starting a plan is a durable operation: the steps are written to `plan_start_runs` before the first task is
 * created, and every created task is appended as it is linked. The step keys (`plan:<messageId>:<index>`) make
 * the Hermes writes idempotent, so resuming after a crash never creates a step twice.
 */
export function createPlanStarter(deps: {
  port: HermesPort
  db: ScoreDb
  ingest: Ingest
}): PlanStarter {
  const { port, db, ingest } = deps

  const readRun = (messageId: string): PlanRun | undefined =>
    db.read((sqlite) => {
      const row = sqlite
        .prepare('SELECT * FROM plan_start_runs WHERE message_id = ?')
        .get(messageId)
      return row === undefined ? undefined : RunRow.parse(row)
    })

  async function execute(run: PlanRun): Promise<PlanStartResponse> {
    const taskIds = [...run.task_ids]
    const brief = db.read((sqlite) => readBriefRow(sqlite, run.brief_id))
    if (!brief) throw new HttpError(404, 'not_found', 'Unknown brief')
    for (const step of run.steps.slice(taskIds.length)) {
      const task = await port.createTask(
        {
          title: step.title,
          assignee: step.agentId,
          roomId: run.room_id,
          body: `Step ${step.index + 1} of the plan for: ${redact(brief.title)}`,
          ...(taskIds.length ? { dependsOn: [taskIds.at(-1)!] } : {}),
        },
        `plan:${run.message_id}:${step.index}`,
      )
      taskIds.push(task.id)
      const last = taskIds.length === run.steps.length
      // Link and record at once: a later step failing must not leave a running task outside its brief.
      await ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          linkTasks(sqlite, run.brief_id, [{ taskId: task.id, origin: 'plan' as const }], now)
          // A step linked earlier may already have claimed this one as its dependency child.
          sqlite
            .prepare(
              "UPDATE brief_tasks SET origin = 'plan' WHERE brief_id = ? AND task_id = ? AND origin = 'child'",
            )
            .run(run.brief_id, task.id)
          sqlite
            .prepare(
              `UPDATE plan_start_runs SET task_ids = ?, state = ?, error = NULL, updated_at = ? WHERE message_id = ?`,
            )
            .run(JSON.stringify(taskIds), last ? 'done' : 'running', now, run.message_id)
          if (last)
            sqlite
              .prepare(
                `INSERT INTO brief_plan_starts (message_id, brief_id, started_at) VALUES (?, ?, ?)
                 ON CONFLICT DO NOTHING`,
              )
              .run(run.message_id, run.brief_id, now)
          return emitBriefChange(sqlite, run.brief_id, true)
        },
      })
    }
    return { briefId: run.brief_id, taskIds }
  }

  async function fail(run: PlanRun, reason: string): Promise<void> {
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        sqlite
          .prepare(
            "UPDATE plan_start_runs SET state = 'failed', error = ?, updated_at = ? WHERE message_id = ? AND state = 'running'",
          )
          .run(reason, now, run.message_id)
        const plan = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(run.message_id)
        const author: Message['author'] = plan ? messageFromRow(plan).author : { kind: 'you' }
        return storeMessage(
          sqlite,
          {
            id: `plan-start-failed:${run.message_id}`,
            roomId: run.room_id,
            author,
            to: [],
            parts: [
              {
                kind: 'text',
                text: `The plan could not be started (${run.task_ids.length} of ${run.steps.length} steps were created). ${reason} Press Start plan again to continue.`,
              },
            ],
            refs: [],
            streaming: false,
            createdAt: now,
          },
          now,
        )
      },
    })
  }

  return {
    start(roomId, messageId) {
      return withKeyedLock(lockKey(messageId), async () => {
        const found = db.read((sqlite) => {
          const row = sqlite
            .prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
            .get(messageId, roomId)
          if (row === undefined) throw new HttpError(404, 'not_found', 'Unknown message')
          const message = messageFromRow(row)
          const part = message.parts.find((item) => item.kind === 'plan')
          if (!part) throw new HttpError(400, 'bad_request', 'This message has no plan')
          if (message.streaming)
            throw new HttpError(409, 'conflict', 'The plan is still being written')
          const brief = readBriefRow(sqlite, part.briefId)
          if (!brief) throw new HttpError(404, 'not_found', 'Unknown brief')
          // New tasks would run while the brief claims to be paused, and Pause only holds tasks that exist.
          if (brief.paused_at !== null)
            throw new HttpError(409, 'conflict', 'Resume the brief before starting its plan')
          return { part, brief }
        })
        const steps = orderedPlanSteps(found.part)
        if (!steps.length) throw new HttpError(400, 'bad_request', 'The plan has no steps to start')
        await ingest.submit({
          source: 'briefs',
          identity: randomUUID(),
          apply({ sqlite, now }) {
            sqlite
              .prepare(
                `INSERT INTO plan_start_runs (message_id, room_id, brief_id, steps, started_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              )
              .run(messageId, roomId, found.brief.id, JSON.stringify(steps), now, now)
            sqlite
              .prepare(
                "UPDATE plan_start_runs SET state = 'running', updated_at = ? WHERE message_id = ? AND state = 'failed'",
              )
              .run(now, messageId)
            return []
          },
        })
        const run = readRun(messageId)!
        if (run.state === 'done' && run.task_ids.length === run.steps.length)
          return { briefId: run.brief_id, taskIds: run.task_ids }
        return execute(run)
      })
    },

    async recover() {
      const rows = db.read((sqlite) =>
        z
          .array(RunRow)
          .parse(
            sqlite
              .prepare("SELECT * FROM plan_start_runs WHERE state = 'running' ORDER BY rowid")
              .all(),
          ),
      )
      let unresolved = 0
      for (const row of rows) {
        await withKeyedLock(lockKey(row.message_id), async () => {
          const run = readRun(row.message_id)
          if (run?.state !== 'running') return
          // A paused brief must not get new tasks; the person resumes it and presses Start plan again.
          const brief = db.read((sqlite) => readBriefRow(sqlite, run.brief_id))
          if (brief?.paused_at) {
            await fail(run, 'The brief is paused.')
            return
          }
          try {
            await execute(run)
          } catch (error) {
            // Hermes unreachable or a write failed midway: try again on the next pass.
            if (error instanceof HttpError && error.status >= 400 && error.status < 500)
              await fail(run, 'Hermes refused a step.')
            else unresolved++
          }
        })
      }
      return unresolved
    },
  }
}

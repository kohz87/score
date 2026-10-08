import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { briefTasks, emitBriefChange, requireBrief, taskStatus } from '../domain/briefs.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const NOT_STARTED = ['triage', 'todo', 'scheduled', 'ready']
const PAUSE_REASON = 'Paused from Score'
const RESUME_REASON = 'Resumed from Score'

export interface BriefControl {
  pause(briefId: string): Promise<void>
  resume(briefId: string): Promise<void>
}

/**
 * Pause cannot suspend a running Hermes turn. It holds Score's own queue for the brief and blocks the tasks
 * that have not started; steps already running finish. Shared by the per-brief and the team-wide routes.
 */
export function createBriefControl(deps: {
  port: HermesPort
  db: ScoreDb
  ingest: Ingest
  /** Wakes the room queue after a resume instead of waiting for its periodic sweep. */
  dispatch?: () => Promise<void>
}): BriefControl {
  const { port, ingest, dispatch } = deps

  async function forget(briefId: string, taskId: string): Promise<void> {
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite }) {
        sqlite
          .prepare('DELETE FROM brief_paused_tasks WHERE brief_id = ? AND task_id = ?')
          .run(briefId, taskId)
        return []
      },
    })
  }

  return {
    async pause(briefId) {
      let candidates: string[] = []
      await ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const row = requireBrief(sqlite, briefId)
          if (row.paused_at === null)
            sqlite.prepare('UPDATE briefs SET paused_at = ? WHERE id = ?').run(now, briefId)
          // The row is written before the block is attempted, so a crash never forgets what Score touched.
          candidates = briefTasks(sqlite, briefId)
            .filter(({ detail }) => detail && NOT_STARTED.includes(taskStatus(detail)))
            .map(({ taskId }) => taskId)
            .filter(
              (taskId) =>
                sqlite
                  .prepare('SELECT 1 FROM brief_paused_tasks WHERE brief_id = ? AND task_id = ?')
                  .get(briefId, taskId) === undefined,
            )
          for (const taskId of candidates)
            sqlite
              .prepare(
                'INSERT INTO brief_paused_tasks (brief_id, task_id, blocked_at) VALUES (?, ?, ?)',
              )
              .run(briefId, taskId, now)
          return emitBriefChange(sqlite, briefId, true)
        },
      })
      for (const taskId of candidates) {
        try {
          await port.taskAction({ taskId, action: 'block', text: PAUSE_REASON })
        } catch {
          // Not blocked: forget it so Resume never touches a task Score did not block.
          await forget(briefId, taskId)
        }
      }
    },

    async resume(briefId) {
      let ours: string[] = []
      await ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite }) {
          requireBrief(sqlite, briefId)
          sqlite.prepare('UPDATE briefs SET paused_at = NULL WHERE id = ?').run(briefId)
          ours = z
            .array(z.object({ task_id: z.string() }))
            .parse(
              sqlite
                .prepare('SELECT task_id FROM brief_paused_tasks WHERE brief_id = ? ORDER BY rowid')
                .all(briefId),
            )
            .map((row) => row.task_id)
          return emitBriefChange(sqlite, briefId, true)
        },
      })
      await dispatch?.()
      const failed: string[] = []
      for (const taskId of ours) {
        try {
          // Only what Score blocked, and only if it is still blocked (the person may have moved it since).
          const task = await port.getTask(taskId).catch((error: unknown) => {
            if (error instanceof HttpError && error.status === 404) return undefined
            throw error
          })
          if (task && taskStatus(task) === 'blocked')
            await port.taskAction({ taskId, action: 'unblock', text: RESUME_REASON })
          await forget(briefId, taskId)
        } catch {
          failed.push(taskId)
        }
      }
      if (failed.length)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Resumed, but some tasks could not be unblocked. Try Resume again.',
          { taskIds: failed },
        )
    },
  }
}

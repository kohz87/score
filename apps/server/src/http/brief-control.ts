import { randomUUID } from 'node:crypto'
import type { ScoreDb } from '../db/index.ts'
import { actionableBriefTasks, emitBriefChange, requireBrief, taskStatus } from '../domain/briefs.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { holdable, recordHolds } from '../domain/holds.ts'
import type { TaskHolds } from './task-holds.ts'

export interface BriefControl {
  pause(briefId: string): Promise<void>
  resume(briefId: string): Promise<void>
}

/**
 * Pause cannot suspend a running Hermes turn. It holds Score's own queue for the brief and parks the tasks
 * that have not started (see task-holds.ts); steps already running finish. Shared by the per-brief and the
 * team-wide routes.
 */
export function createBriefControl(deps: {
  port: HermesPort
  db: ScoreDb
  ingest: Ingest
  holds: TaskHolds
  /** Wakes the room queue after a resume instead of waiting for its periodic sweep. */
  dispatch?: () => Promise<void>
}): BriefControl {
  const { db, ingest, holds, dispatch } = deps
  const isPaused = (briefId: string) =>
    db.read(
      (sqlite) =>
        sqlite
          .prepare('SELECT 1 FROM briefs WHERE id = ? AND paused_at IS NOT NULL')
          .get(briefId) !== undefined,
    )

  return {
    async pause(briefId) {
      await ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const row = requireBrief(sqlite, briefId)
          if (row.paused_at === null)
            sqlite.prepare('UPDATE briefs SET paused_at = ? WHERE id = ?').run(now, briefId)
          // Intent is written before Hermes is touched, so a crash or a refusal is retried, never forgotten.
          recordHolds(
            sqlite,
            { kind: 'brief', id: briefId },
            actionableBriefTasks(sqlite, briefId)
              .filter(
                ({ taskId, detail }) => detail && holdable(sqlite, taskId, taskStatus(detail)),
              )
              .map(({ taskId }) => taskId),
            now,
          )
          return emitBriefChange(sqlite, briefId, true)
        },
      })
      const failed = await holds.apply({ kind: 'brief', id: briefId }, () => isPaused(briefId))
      if (failed.length)
        throw new HttpError(
          502,
          'hermes_unavailable',
          'Paused, but some tasks could not be held. Try Pause again.',
          { taskIds: failed },
        )
    },

    async resume(briefId) {
      await ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite }) {
          requireBrief(sqlite, briefId)
          sqlite.prepare('UPDATE briefs SET paused_at = NULL WHERE id = ?').run(briefId)
          return emitBriefChange(sqlite, briefId, true)
        },
      })
      await dispatch?.()
      const failed = await holds.release({ kind: 'brief', id: briefId })
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

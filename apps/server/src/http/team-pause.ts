import { TaskDetailSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import { ownerOfBrief } from '../domain/orchestration/ownership.ts'
import { emitBriefChange, listBriefs, taskStatus } from '../domain/briefs.ts'
import { holdable, recordHolds } from '../domain/holds.ts'
import { countRunningRuns, setTeamPaused, teamPausedAt } from '../domain/team-pause.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { BriefControl } from './brief-control.ts'
import { requestIdempotency } from './idempotency.ts'
import type { TaskHolds } from './task-holds.ts'

const IdRow = z.object({ brief_id: z.string() })
const DetailRow = z.object({ detail: z.string() })
const TEAM = { kind: 'team', id: 'team' } as const

// Pause everyone (H): holds Score's dispatch queue for all agents and pauses every running brief through the
// same logic as a single brief. Steps already running finish, so affectedRuns counts runs, it does not stop them.
export function registerTeamPauseRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    control: BriefControl
    holds: TaskHolds
    dispatch?: () => Promise<void>
    clock?: () => number
    orchestrator?: Pick<Orchestrator, 'recordHold'>
  },
): void {
  const { db, ingest, control, holds, dispatch, orchestrator } = deps
  const receipts = requestIdempotency(db, deps.clock ?? Date.now)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  const response = (paused: boolean): { paused: boolean; affectedRuns: number } => ({
    paused,
    affectedRuns: db.read((sqlite) => countRunningRuns(sqlite)),
  })

  app.post('/api/team/pause', mutation, async () => {
    // Journaled first: an orchestration's admissions depend on this hold (fix-h item 2).
    orchestrator?.recordHold({ kind: 'team' }, 'set')
    let targets: string[] = []
    await ingest.submit({
      source: 'team',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        sqlite
          .prepare('UPDATE team_state SET paused_at = ? WHERE id = 1 AND paused_at IS NULL')
          .run(now)
        targets = listBriefs(sqlite, 'active', Date.parse(now))
          // An orchestration's brief is held by its own admission checks (the team hold above); pausing it as a brief
          // would put a second owner on the run, and Team Resume would then clear the wrong hold.
          .filter((brief) => brief.status === 'running' && !ownerOfBrief(sqlite, brief.id))
          .map((brief) => brief.id)
        for (const id of targets)
          sqlite.prepare('INSERT OR IGNORE INTO team_paused_briefs (brief_id) VALUES (?)').run(id)
        // Tasks that exist already (standalone ones too) are held under the team owner, like later arrivals; the
        // intent is written before Hermes is touched, so recovery finishes it after a crash.
        recordHolds(
          sqlite,
          TEAM,
          z
            .array(DetailRow)
            .parse(sqlite.prepare('SELECT detail FROM task_projections').all())
            .map((row) => TaskDetailSchema.parse(JSON.parse(row.detail)))
            .filter((task) => holdable(sqlite, task.id, taskStatus(task)))
            .map((task) => task.id),
          now,
        )
        return []
      },
    })
    const failed: string[] = []
    for (const id of targets) {
      try {
        await control.pause(id)
      } catch {
        failed.push(id)
      }
    }
    const teamFailed = await holds.apply(
      TEAM,
      () => db.read((sqlite) => teamPausedAt(sqlite)) !== null,
    )
    if (failed.length || teamFailed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Paused, but some briefs could not hold all their tasks. Try Pause again.',
        { briefIds: failed, taskIds: teamFailed },
      )
    return response(true)
  })

  app.post('/api/team/resume', mutation, async () => {
    orchestrator?.recordHold({ kind: 'team' }, 'lift')
    let briefs: string[] = []
    await ingest.submit({
      source: 'team',
      identity: randomUUID(),
      apply({ sqlite }) {
        setTeamPaused(sqlite, null)
        briefs = z
          .array(IdRow)
          .parse(sqlite.prepare('SELECT brief_id FROM team_paused_briefs ORDER BY rowid').all())
          .map((row) => row.brief_id)
        // The briefs this Pause paused are resumed in the same transaction as the team: after a crash, startup
        // recovery sees them unpaused and releases their task holds, instead of leaving them paused for good.
        const drafts = briefs.flatMap((id) => {
          sqlite.prepare('UPDATE briefs SET paused_at = NULL WHERE id = ?').run(id)
          sqlite.prepare('DELETE FROM team_paused_briefs WHERE brief_id = ?').run(id)
          return sqlite.prepare('SELECT 1 FROM briefs WHERE id = ?').get(id) === undefined
            ? []
            : emitBriefChange(sqlite, id, true)
        })
        return drafts
      },
    })
    await dispatch?.()
    const failed: string[] = []
    for (const id of briefs) {
      try {
        if ((await holds.release({ kind: 'brief', id })).length) failed.push(id)
      } catch {
        failed.push(id)
      }
    }
    // Tasks that arrived while everyone was paused are held under the team owner.
    const teamFailed = await holds.release({ kind: 'team', id: 'team' })
    if (failed.length || teamFailed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Resumed, but some briefs could not be fully resumed. Try Resume again.',
        { briefIds: failed, taskIds: teamFailed },
      )
    return response(false)
  })
}

import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { listBriefs } from '../domain/briefs.ts'
import { countRunningRuns, setTeamPaused } from '../domain/team-pause.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { BriefControl } from './brief-control.ts'
import { requestIdempotency } from './idempotency.ts'

const IdRow = z.object({ brief_id: z.string() })

// Pause everyone (H): holds Score's dispatch queue for all agents and pauses every running brief through the
// same logic as a single brief. Steps already running finish, so affectedRuns counts runs, it does not stop them.
export function registerTeamPauseRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    control: BriefControl
    dispatch?: () => Promise<void>
    clock?: () => number
  },
): void {
  const { db, ingest, control, dispatch } = deps
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
    let targets: string[] = []
    await ingest.submit({
      source: 'team',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        sqlite
          .prepare('UPDATE team_state SET paused_at = ? WHERE id = 1 AND paused_at IS NULL')
          .run(now)
        targets = listBriefs(sqlite, 'active', Date.parse(now))
          .filter((brief) => brief.status === 'running')
          .map((brief) => brief.id)
        for (const id of targets)
          sqlite.prepare('INSERT OR IGNORE INTO team_paused_briefs (brief_id) VALUES (?)').run(id)
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
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Paused, but some briefs could not hold all their tasks. Try Pause again.',
        { briefIds: failed },
      )
    return response(true)
  })

  app.post('/api/team/resume', mutation, async () => {
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
        return []
      },
    })
    await dispatch?.()
    const failed: string[] = []
    for (const id of briefs) {
      try {
        await control.resume(id)
        await ingest.submit({
          source: 'team',
          identity: randomUUID(),
          apply({ sqlite }) {
            sqlite.prepare('DELETE FROM team_paused_briefs WHERE brief_id = ?').run(id)
            return []
          },
        })
      } catch {
        failed.push(id)
      }
    }
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Resumed, but some briefs could not be fully resumed. Try Resume again.',
        { briefIds: failed },
      )
    return response(false)
  })
}

import { AttemptDetailSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { attemptDetail, attemptsByIds, kanbanAttemptsEnabled } from '../domain/kanban-attempts.ts'
import { HttpError } from '../errors.ts'

// A Kanban attempt (5.17a-1), also from an earlier copy of the board: read-only, with the frozen task snapshot.
export function registerAttemptRoutes(app: FastifyInstance, deps: { db: ScoreDb }): void {
  const { db } = deps
  app.get('/api/attempts/:attemptId', async (request) => {
    const { attemptId } = z
      .object({ attemptId: z.string().regex(/^kr_[A-Za-z0-9-]{1,64}$/) })
      .parse(request.params)
    // With attempts off the route does not exist as far as clients can tell.
    if (!kanbanAttemptsEnabled()) throw new HttpError(404, 'not_found', 'Unknown attempt')
    const attempt = db.read((sqlite) => attemptsByIds(sqlite, [attemptId])[0])
    if (!attempt) throw new HttpError(404, 'not_found', 'Unknown attempt')
    return AttemptDetailSchema.parse(attemptDetail(attempt))
  })
}

import { AgentSummarySchema, NowSnapshotSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { AgentDetailSchema } from '@score/contract'
import { readAgent, reconcileAgents } from '../domain/agents.ts'
import { readNow } from '../domain/now.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { headSeq } from '../hub/snapshot.ts'

const HOUR = 3_600_000
const MAX_SPAN = 7 * 24 * HOUR
const QuerySchema = z
  .object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
  .strict()

export function registerNowRoutes(
  app: FastifyInstance,
  deps: {
    port: HermesPort
    db: ScoreDb
    ingest: Ingest
    disabled: () => readonly string[]
    clock?: () => number
  },
): void {
  const { port, db, ingest, disabled, clock = Date.now } = deps
  app.get('/api/now', async (request) => {
    const query = QuerySchema.parse(request.query)
    const now = clock()
    const from = query.from ?? new Date(now - 2 * HOUR).toISOString()
    const to = query.to ?? new Date(now + HOUR).toISOString()
    const span = Date.parse(to) - Date.parse(from)
    if (span <= 0 || span > MAX_SPAN)
      throw new HttpError(400, 'bad_request', 'Use a window of 0–7 days.')
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await reconcileAgents(ingest, details)
    // Not `snapshot()`: that guard caps nesting at 8 and a plan message's lanes go deeper.
    const result = db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      ...readNow(sqlite, {
        from,
        to,
        now,
        disabled: disabled(),
        agents: details.map((detail) => AgentSummarySchema.parse(readAgent(sqlite, detail.id))),
      }),
    }))
    return NowSnapshotSchema.parse(result)
  })
}

import { AgentDetailSchema, AgentSummarySchema, WatchFrameSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { readAgent, reconcileAgents } from '../domain/agents.ts'
import { isLive, readWatch } from '../domain/watch-frames.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const QuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
export const WatchResponseSchema = z.object({
  asOfSeq: z.int().nonnegative(),
  agent: AgentSummarySchema,
  live: z.boolean(),
  frames: z.array(WatchFrameSchema),
  markers: z.array(
    z.object({
      seq: z.int().positive(),
      at: z.iso.datetime(),
      kind: z.enum(['command', 'file', 'browser', 'asked']),
    }),
  ),
})
export const WatchOverviewSchema = z.object({
  items: z.array(
    z.object({
      agent: AgentSummarySchema,
      thumbnail: z.string().nullable(),
      status: z.string(),
    }),
  ),
})

function overview(
  sqlite: DatabaseSync,
  agentIds: string[],
): { agent: z.infer<typeof AgentSummarySchema>; thumbnail: string | null; status: string }[] {
  const items: {
    agent: z.infer<typeof AgentSummarySchema>
    thumbnail: string | null
    status: string
  }[] = []
  for (const id of agentIds) {
    const detail = readAgent(sqlite, id)
    if (!detail) continue
    const last = sqlite
      .prepare('SELECT caption FROM watch_frames WHERE agent_id = ? ORDER BY seq DESC LIMIT 1')
      .get(id)
    const caption = last ? z.object({ caption: z.string() }).parse(last).caption : null
    items.push({
      agent: AgentSummarySchema.parse(detail),
      // Screenshots arrive with the media store (task 4.3).
      thumbnail: null,
      status: isLive(sqlite, id) ? (caption ?? 'Working') : (caption ?? 'Idle'),
    })
  }
  return items
}

// Watch is an event replay (D6): read-only views over the redacted frames stored by the bridge ingest.
export function registerWatchRoutes(
  app: FastifyInstance,
  deps: { port: HermesPort; db: ScoreDb; ingest: Ingest },
): void {
  const { port, db, ingest } = deps
  async function agentIds(): Promise<string[]> {
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await reconcileAgents(ingest, details)
    return details.map((agent) => agent.id)
  }

  app.get('/api/agents/:agentId/watch', async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const query = QuerySchema.parse(request.query)
    if (!(await agentIds()).includes(agentId))
      throw new HttpError(404, 'not_found', 'Agent not found')
    const result = snapshot(db, (sqlite) => {
      const agent = readAgent(sqlite, agentId)
      if (!agent) throw new HttpError(404, 'not_found', 'Agent not found')
      return {
        agent: AgentSummarySchema.parse(agent),
        live: isLive(sqlite, agentId),
        ...readWatch(sqlite, agentId, query),
      }
    })
    return WatchResponseSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  app.get('/api/watch/overview', async () => {
    const ids = await agentIds()
    const result = snapshot(db, (sqlite) => overview(sqlite, ids))
    return WatchOverviewSchema.parse({ items: result.data })
  })
}

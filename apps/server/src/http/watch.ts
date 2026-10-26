import {
  AgentDetailSchema,
  AgentSummarySchema,
  BotScreenStatusSchema,
  WatchOverviewSchema,
  type WatchOverviewItem,
  WatchResponseSchema,
} from '@score/contract'
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
const LastFrameRow = z.object({
  caption: z.string(),
  surface: z.enum(['terminal', 'editor', 'browser']),
})
const QuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})
function latestSession(sqlite: DatabaseSync, agentId: string): string | null {
  const row = sqlite
    .prepare(
      "SELECT session_id FROM runs WHERE profile = ? AND runtime = 'hermes' AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(agentId)
  return row ? z.object({ session_id: z.string().min(1) }).parse(row).session_id : null
}

function overview(sqlite: DatabaseSync, agentIds: string[]): WatchOverviewItem[] {
  const items: WatchOverviewItem[] = []
  for (const id of agentIds) {
    const detail = readAgent(sqlite, id)
    if (!detail) continue
    const last = sqlite
      .prepare(
        'SELECT caption, surface FROM watch_frames WHERE agent_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(id)
    const row = last ? LastFrameRow.parse(last) : null
    const live = isLive(sqlite, id)
    items.push({
      agent: AgentSummarySchema.parse(detail),
      // Screenshots arrive with the media store (task 4.3).
      thumbnail: null,
      status: live ? (row?.caption ?? 'Working') : (row?.caption ?? 'Idle'),
      live,
      surface: row?.surface ?? null,
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
    // A deleted agent leaves the Hermes roster but its retained frames stay readable while Score still lists it.
    const retained = db.sqlite
      .prepare('SELECT 1 FROM agent_lifecycle WHERE agent_id = ?')
      .get(agentId)
    if (!(await agentIds()).includes(agentId) && !retained)
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const result = snapshot(db, (sqlite) => {
      const agent = readAgent(sqlite, agentId)
      if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      return {
        agent: AgentSummarySchema.parse(agent),
        live: isLive(sqlite, agentId),
        sessionId: latestSession(sqlite, agentId),
        ...readWatch(sqlite, agentId, query),
        gaps: agentGaps(sqlite, agentId),
      }
    })
    return WatchResponseSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  // 3.3.0 Bot Screen (decision 135): read-only; the adapter never sends input or takes the lease.
  async function botScreenAgent(params: unknown) {
    const { agentId } = ParamsSchema.parse(params)
    if (!(await agentIds()).includes(agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return agentId
  }
  app.get('/api/agents/:agentId/bot-screen', async (request, reply) => {
    const agentId = await botScreenAgent(request.params)
    reply.header('cache-control', 'no-store')
    return BotScreenStatusSchema.parse(await port.botScreenStatus(agentId))
  })
  app.get('/api/agents/:agentId/bot-screen/frame', async (request, reply) => {
    const agentId = await botScreenAgent(request.params)
    const frame = await port.botScreenFrame(agentId)
    if (!('png' in frame))
      throw new HttpError(409, 'conflict', 'The screen isn’t showing right now.', {
        state: BotScreenStatusSchema.parse(frame).state,
      })
    const etag = `"${frame.seq}"`
    reply.header('cache-control', 'no-store').header('etag', etag)
    if (request.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.type('image/png').send(frame.png)
  })

  app.get('/api/watch/overview', async () => {
    const ids = await agentIds()
    const result = snapshot(db, (sqlite) => overview(sqlite, ids))
    return WatchOverviewSchema.parse({ items: result.data })
  })
}

function agentGaps(sqlite: DatabaseSync, agentId: string) {
  return z
    .array(
      z.object({ from: z.iso.datetime(), to: z.iso.datetime().nullable(), reason: z.string() }),
    )
    .parse(
      sqlite
        .prepare(
          `SELECT g.from_ts AS "from", g.to_ts AS "to", g.reason FROM gaps g JOIN runs r ON r.id = g.run_id
           WHERE r.profile = ? ORDER BY g.id DESC LIMIT 50`,
        )
        .all(agentId),
    )
    .reverse()
}

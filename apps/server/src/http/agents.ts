import { AgentStyleSchema, AgentSummarySchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { AgentDetailSchema } from '../domain/agent-detail.ts'
import { readAgent, readAgentStyle, reconcileAgents, storeAgent } from '../domain/agents.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { requestIdempotency } from './idempotency.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const StylePatchSchema = AgentStyleSchema.partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0)
export function registerAgentRoutes(
  app: FastifyInstance,
  port: HermesPort,
  ingest?: Ingest,
  db?: ScoreDb,
  clock = Date.now,
): void {
  function storage() {
    if (!db || !ingest)
      throw new HttpError(503, 'hermes_unavailable', 'Agent storage is unavailable')
    return { db, ingest }
  }
  async function refresh() {
    const { db, ingest } = storage()
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await reconcileAgents(ingest, details)
    return { db, ids: details.map((agent) => agent.id) }
  }
  app.get('/api/agents', async () => {
    const { db, ids } = await refresh()
    const result = snapshot(db, (sqlite) =>
      ids.map((id) => AgentSummarySchema.parse(readAgent(sqlite, id))),
    )
    return { asOfSeq: result.asOfSeq, items: result.data }
  })
  app.get('/api/agents/:agentId', async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const { db, ids } = await refresh()
    if (!ids.includes(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    return snapshot(db, (sqlite) => readAgent(sqlite, agentId)).data
  })
  const receipts = requestIdempotency(db, clock)
  app.patch(
    '/api/agents/:agentId/style',
    {
      preHandler: [humanGuard(app.pairing), receipts.preHandler],
      onSend: receipts.onSend,
    },
    async (request) => {
      const { agentId } = ParamsSchema.parse(request.params)
      const patch = StylePatchSchema.parse(request.body)
      const { ids } = await refresh()
      if (!ids.includes(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
      const { ingest } = storage()
      let response: z.infer<typeof AgentSummarySchema> | undefined
      await ingest.submit({
        source: 'agent-style',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const previous = readAgent(sqlite, agentId)
          if (!previous) throw new HttpError(404, 'not_found', 'Agent not found')
          const style = AgentStyleSchema.parse({
            ...(readAgentStyle(sqlite, agentId) ?? previous.style),
            ...patch,
          })
          const agent = AgentDetailSchema.parse({ ...previous, style })
          sqlite
            .prepare(
              'INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET color = excluded.color, shape = excluded.shape, updated_at = excluded.updated_at',
            )
            .run(agentId, style.color, style.shape, now)
          storeAgent(sqlite, agent)
          response = AgentSummarySchema.parse(agent)
          return JSON.stringify(previous.style) === JSON.stringify(style)
            ? []
            : [{ type: 'agent.updated', data: response }]
        },
      })
      return response
    },
  )
}

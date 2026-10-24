import { RunsOnSchema, RunsOnUpdateSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'

const AgentParams = z.object({ agentId: z.string().min(1).max(256) })

// Where an agent runs (contract § Where an agent runs, PLAN 11.8a). Both routes are human-guarded: the answer
// describes the agent's isolation, and changing it is the person's decision (D7.1).
export function registerRunsOnRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  app.get(
    '/api/agents/:agentId/runs-on',
    { preHandler: humanGuard(app.pairing) },
    async (request) => {
      const { agentId } = AgentParams.parse(request.params)
      return RunsOnSchema.parse(await port.readRunsOn(agentId))
    },
  )
  app.put(
    '/api/agents/:agentId/runs-on',
    { preHandler: [humanGuard(app.pairing), receipts.preHandler], onSend: receipts.onSend },
    async (request) => {
      const { agentId } = AgentParams.parse(request.params)
      const update = RunsOnUpdateSchema.parse(request.body)
      const answer = RunsOnSchema.parse(await port.setRunsOn(agentId, update))
      request.log.info({ agentId, runsOn: { backend: update.backend } }, 'agent backend set')
      return answer
    },
  )
}

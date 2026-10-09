import type { FastifyInstance } from 'fastify'
import { KnowledgeAgentAccessSchema, KnowledgeAgentUsageSchema } from '@score/contract'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { KnowledgeAgentApi } from '../knowledge/agent-api.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })

// Contract §12: the per-agent "Knowledge tools" switch and today's write counts. The tools themselves are bridge routes.
export function registerKnowledgeAgentRoutes(app: FastifyInstance, api: KnowledgeAgentApi): void {
  app.get('/api/knowledge/agent-usage', async () =>
    KnowledgeAgentUsageSchema.parse({ items: api.usageToday() }),
  )
  app.get('/api/agents/:agentId/knowledge', async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    return KnowledgeAgentAccessSchema.parse({ enabled: api.agentEnabled(agentId) })
  })
  app.put(
    '/api/agents/:agentId/knowledge',
    { preHandler: [humanGuard(app.pairing)] },
    async (request) => {
      const { agentId } = ParamsSchema.parse(request.params)
      const { enabled } = KnowledgeAgentAccessSchema.parse(request.body)
      api.setAgentEnabled(agentId, enabled)
      return KnowledgeAgentAccessSchema.parse({ enabled })
    },
  )
}

import { ApplySubagentSetupSchema, SubagentSetupSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { humanGuard } from '../auth/human.ts'
import type { HermesPort } from '../hermes/index.ts'

/** docs/API-CONTRACT.md §19: whether each Hermes agent is set up for subagents, and the change that sets it up. */
export function registerSubagentSetupRoutes(
  app: FastifyInstance,
  port: Pick<HermesPort, 'subagentSetup' | 'applySubagentSetup'>,
): void {
  app.get('/api/subagent-setup', async () => SubagentSetupSchema.parse(await port.subagentSetup()))
  app.post(
    '/api/subagent-setup/apply',
    { preHandler: humanGuard(app.pairing) },
    async (request) => {
      const { agentIds } = ApplySubagentSetupSchema.parse(request.body)
      return SubagentSetupSchema.parse(await port.applySubagentSetup(agentIds))
    },
  )
}

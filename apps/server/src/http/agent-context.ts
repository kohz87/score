import { AgentContextSchema, AgentSummarySchema, type AgentContext } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const RowSchema = z.object({
  model: z.string().nullable(),
  input_tokens: z.int().nonnegative().nullable(),
  output_tokens: z.int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
})

// Usage of the agent's latest run that reported any (PLAN 5.25), for the Chat context meter and /usage. The window comes
// from Hermes's model options when they carry one; otherwise the meter shows only what was used.
export function registerAgentContextRoutes(
  app: FastifyInstance,
  deps: { port: HermesPort; db: ScoreDb },
): void {
  app.get('/api/agents/:agentId/context', async (request): Promise<AgentContext> => {
    const { agentId } = ParamsSchema.parse(request.params)
    return readAgentContext(deps, agentId)
  })
}

/** The totals of the agent's latest run with usage (404 for an unknown agent); the meter's fallback too. */
export async function readAgentContext(
  deps: { port: HermesPort; db: ScoreDb },
  agentId: string,
): Promise<AgentContext> {
  const { port, db } = deps
  const agents = z.array(AgentSummarySchema).parse(await port.listAgents())
  const agent = agents.find((item) => item.id === agentId)
  if (!agent) throw new HttpError(404, 'not_found', 'Agent not found')
  const row = RowSchema.nullish().parse(
    db.sqlite
      .prepare(
        `SELECT model, input_tokens, output_tokens, cost_usd FROM runs
           WHERE profile = ? AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
           ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(agentId),
  )
  const model = row?.model ?? agent.model?.id ?? null
  let contextLength: number | null = null
  if (model) {
    const options = await port.listModels(model).catch(() => [])
    contextLength = options.find((item) => item.model === model)?.contextLength ?? null
  }
  return AgentContextSchema.parse({
    model,
    tokens: row ? { input: row.input_tokens, output: row.output_tokens } : null,
    costUsd: row?.cost_usd ?? null,
    contextLength,
  })
}

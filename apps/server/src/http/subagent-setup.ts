import {
  AgentSubagentsRequestSchema,
  AgentSubagentsSchema,
  ApplySubagentSetupSchema,
  SUBAGENT_LIMITS,
  SubagentSetupSchema,
  type AgentSubagents,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { ceilingOf, setCeiling } from '../domain/subagents.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const AgentParams = z.object({ agentId: z.string().min(1).max(256) })

/** docs/API-CONTRACT.md §19: whether each Hermes agent is set up for subagents, its ceiling, and the changes to them. */
export function registerSubagentSetupRoutes(
  app: FastifyInstance,
  deps: {
    /** The port with the coding agents: an agent's program decides what can be controlled. */
    port: Pick<HermesPort, 'listAgents'>
    hermes: Pick<
      HermesPort,
      | 'subagentSetup'
      | 'applySubagentSetup'
      | 'subagentConfig'
      | 'setSubagentConfig'
      | 'refreshSubagentPolicies'
    >
    db?: ScoreDb | undefined
    ingest?: Ingest | undefined
    onError?: (error: unknown) => void
  },
): void {
  const { port, hermes, db, ingest } = deps
  app.get('/api/subagent-setup', async () =>
    SubagentSetupSchema.parse(await hermes.subagentSetup()),
  )
  app.post(
    '/api/subagent-setup/apply',
    { preHandler: humanGuard(app.pairing) },
    async (request) => {
      const { agentIds } = ApplySubagentSetupSchema.parse(request.body)
      return SubagentSetupSchema.parse(await hermes.applySubagentSetup(agentIds))
    },
  )

  async function view(agentId: string): Promise<AgentSubagents> {
    const agent = (await port.listAgents()).find((one) => one.id === agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const runtime = agent.runtime ?? 'hermes'
    const ceiling = db?.read((sqlite) => ceilingOf(sqlite, agentId)) ?? {
      enabled: true,
      maxConcurrent: SUBAGENT_LIMITS.defaultConcurrent,
    }
    const config = runtime === 'hermes' ? await hermes.subagentConfig(agentId) : null
    return AgentSubagentsSchema.parse({
      agentId,
      control: runtime === 'hermes' ? 'limits' : runtime === 'claude-code' ? 'on_off' : 'none',
      enabled: ceiling.enabled,
      maxConcurrent: ceiling.maxConcurrent,
      model: config?.model ?? null,
      maxIterations: config?.maxIterations ?? null,
      timeoutSeconds: config?.timeoutSeconds ?? null,
    })
  }

  app.get('/api/agents/:agentId/subagents', async (request) =>
    view(AgentParams.parse(request.params).agentId),
  )
  app.put(
    '/api/agents/:agentId/subagents',
    { preHandler: humanGuard(app.pairing) },
    async (request) => {
      const { agentId } = AgentParams.parse(request.params)
      const change = AgentSubagentsRequestSchema.parse(request.body)
      const before = await view(agentId)
      if (before.control === 'none')
        throw new HttpError(409, 'conflict', 'Score can’t control this agent’s subagents yet.')
      if (before.control === 'limits') {
        const config = Object.fromEntries(
          Object.entries(change).filter(([field]) => field !== 'enabled'),
        )
        if (Object.keys(config).length) await hermes.setSubagentConfig(agentId, config)
      }
      const ceiling = {
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.maxConcurrent === undefined ? {} : { maxConcurrent: change.maxConcurrent }),
      }
      db?.tx((sqlite) => setCeiling(sqlite, agentId, ceiling))
      // The agent's open jobs get the new ceiling at their next delegate_task, not their next turn.
      for (const jobId of db?.read((sqlite) => jobsOfAgent(sqlite, agentId)) ?? [])
        hermes.refreshSubagentPolicies(jobId)
      return view(agentId)
    },
  )

  // A change or a count reaches every session of the job: the guard reads only its own file.
  const stop = ingest?.onCommitted((events) => {
    for (const event of events)
      if (event.type === 'subagents.changed') {
        try {
          hermes.refreshSubagentPolicies(event.data.jobId)
        } catch (error) {
          deps.onError?.(error)
        }
      }
  })
  if (stop)
    app.addHook('preClose', async () => {
      stop()
    })
}

const jobsOfAgent = (sqlite: Parameters<typeof ceilingOf>[0], profile: string): string[] =>
  (
    sqlite
      .prepare('SELECT DISTINCT job_id FROM subagent_sessions WHERE profile = ?')
      .all(profile) as { job_id: string }[]
  ).map((row) => row.job_id)

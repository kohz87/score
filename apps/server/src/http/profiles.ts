import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  AgentCreateRequestSchema,
  AgentDeleteRequestSchema,
  AgentPatchRequestSchema,
  AgentPreviewRequestSchema,
  AgentDetailSchema,
  AgentSummarySchema,
  ProfileNameSchema,
} from '@score/contract'
import type { Config } from '../config.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { ProfileOperations } from '../domain/profiles.ts'
import { readAgent, reconcileAgents, storeAgent } from '../domain/agents.ts'
import { assertAgentAdmits, applyLifecycle } from '../domain/agent-lifecycle.ts'
import { redact } from '../redact.ts'
import { requestIdempotency } from './idempotency.ts'

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: { db: ScoreDb; ingest: Ingest; port: HermesPort; config: Config; clock?: () => number },
) {
  const { db, ingest, port, config } = deps
  const operations = new ProfileOperations(db, ingest, port, deps.clock)
  const receipts = requestIdempotency(db, deps.clock)
  // Creating agents writes API keys and deleting them removes data, so the transport must be private: loopback, or
  // remote mode over TLS. Plain-HTTP remote mode (owner-accepted for everyday use) refuses these actions.
  const localOnly = async () => {
    if (!profileManagementAllowed(config))
      throw new HttpError(
        403,
        'feature_disabled',
        'Managing agents needs Score on this machine or a TLS connection (SCORE_TLS_CERT)',
      )
  }
  const mutation = {
    preHandler: [humanGuard(app.pairing), localOnly, receipts.preHandler],
    onSend: receipts.onSend,
  }
  const Params = z.object({ agentId: ProfileNameSchema })
  app.addHook('onReady', async () => {
    await operations.recover()
  })
  app.addHook('preClose', async () => {
    await operations.close()
  })
  app.post('/api/agents/preview', mutation, async (request) => {
    await reconcileAgents(ingest, await port.listAgentDetails())
    // Reconcile task projections before counting unfinished assignments in the delete preview.
    const input = AgentPreviewRequestSchema.parse(request.body)
    if (input.kind === 'delete') await port.listTasks()
    return operations.preview(input)
  })
  app.post('/api/agents', mutation, async (request, reply) => {
    const { previewHash, confirmInheritance, ...input } = AgentCreateRequestSchema.parse(
      request.body,
    )
    return reply
      .code(202)
      .send(await operations.begin({ kind: 'create', ...input }, previewHash, confirmInheritance))
  })
  app.delete('/api/agents/:agentId', mutation, async (request, reply) => {
    const { agentId } = Params.parse(request.params)
    const body = AgentDeleteRequestSchema.parse(request.body)
    if (body.typedName !== agentId)
      throw new HttpError(400, 'bad_request', 'Type the exact profile name to delete it')
    await port.listTasks()
    return reply
      .code(202)
      .send(await operations.begin({ kind: 'delete', agentId }, body.previewHash))
  })
  app.get(
    '/api/agents/operations/:opId',
    { preHandler: [humanGuard(app.pairing), localOnly] },
    async (request) => {
      const { opId } = z.object({ opId: z.uuid() }).parse(request.params)
      return operations.refresh(opId)
    },
  )
  app.post('/api/agents/operations/:opId/retry', mutation, async (request) => {
    const { opId } = z.object({ opId: z.uuid() }).parse(request.params)
    return operations.retry(opId)
  })
  app.patch('/api/agents/:agentId', mutation, async (request) => {
    const { agentId } = Params.parse(request.params)
    const body = AgentPatchRequestSchema.parse(request.body)
    await reconcileAgents(ingest, await port.listAgentDetails())
    if (!readAgent(db.sqlite, agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    assertAgentAdmits(db.sqlite, agentId)
    if (body.role) await port.describeProfile(agentId, body.role)
    await reconcileAgents(ingest, await port.listAgentDetails())
    let response: z.infer<typeof AgentDetailSchema> | undefined
    await ingest.submit({
      source: 'profile-description',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        assertAgentAdmits(sqlite, agentId)
        const previous = readAgent(sqlite, agentId)!
        if (body.name) {
          sqlite
            .prepare(
              'INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name',
            )
            .run(agentId, randomUUID(), 'ready', redact(body.name))
        }
        response = AgentDetailSchema.parse(
          applyLifecycle(sqlite, {
            ...previous,
            ...(body.role ? { role: redact(body.role), tagline: redact(body.role) } : {}),
          }),
        )
        storeAgent(sqlite, response)
        return [{ type: 'agent.updated', data: AgentSummarySchema.parse(response) }]
      },
    })
    return response
  })
}

export function profileManagementAllowed(config: Pick<Config, 'host' | 'remote'>): boolean {
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(config.host)
  return loopback || Boolean(config.remote?.tlsCert)
}

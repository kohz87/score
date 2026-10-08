import {
  AgentChannelsResponseSchema,
  AgentDetailSchema,
  AgentSummarySchema,
  MemoryPageSchema,
  SkillHubResponseSchema,
  SkillsResponseSchema,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { readAgentStyle, storeAgent } from '../domain/agents.ts'
import { HttpError } from '../errors.ts'
import {
  AddMemorySchema,
  HubQuerySchema,
  InstallSkillSchema,
  MemoryIdSchema,
  MemoryQuerySchema,
  PatchSkillSchema,
  PatchToolSchema,
  SetModelSchema,
  SkillNameSchema,
  ToolIdSchema,
  type HermesPort,
} from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'

const AgentParams = z.object({ agentId: z.string().min(1).max(256) })

// Team tabs (contract §8): model, skills, memory, tools. Every mutation goes through the adapter, then the
// agent's projection is refreshed from the same readers and announced as `agent.updated`.
export function registerAgentTabRoutes(
  app: FastifyInstance,
  port: HermesPort,
  ingest?: Ingest,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  async function announce(agentId: string) {
    if (!ingest) throw new HttpError(503, 'hermes_unavailable', 'Agent storage is unavailable')
    const detail = z
      .array(AgentDetailSchema)
      .parse(await port.listAgentDetails())
      .find((agent) => agent.id === agentId)
    if (!detail) throw new HttpError(404, 'not_found', 'Agent not found')
    let stored = detail
    await ingest.submit({
      source: 'agent-tabs',
      identity: randomUUID(),
      apply({ sqlite }) {
        stored = AgentDetailSchema.parse({
          ...detail,
          style: readAgentStyle(sqlite, agentId) ?? detail.style,
        })
        storeAgent(sqlite, stored)
        return [{ type: 'agent.updated', data: AgentSummarySchema.parse(stored) }]
      },
    })
    return stored
  }

  app.put('/api/agents/:agentId/model', mutation, async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    await port.setAgentModel(agentId, SetModelSchema.parse(request.body))
    return announce(agentId)
  })

  app.get('/api/agents/:agentId/skills', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    return SkillsResponseSchema.parse({ items: await port.listSkills(agentId) })
  })
  app.post('/api/agents/:agentId/skills', mutation, async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    const { name } = InstallSkillSchema.parse(request.body)
    const items = await port.installSkill(agentId, name)
    await announce(agentId)
    return SkillsResponseSchema.parse({ items })
  })
  app.patch('/api/agents/:agentId/skills/:name', mutation, async (request) => {
    const { agentId, name } = AgentParams.extend({ name: SkillNameSchema }).parse(request.params)
    const { enabled } = PatchSkillSchema.parse(request.body)
    const item = await port.setSkillEnabled(agentId, name, enabled)
    await announce(agentId)
    return item
  })
  app.get('/api/skills/hub', async (request) => {
    const { q } = z.object({ q: HubQuerySchema.default('') }).parse(request.query)
    return SkillHubResponseSchema.parse({ items: await port.searchSkillHub(q) })
  })

  app.get('/api/agents/:agentId/channels', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    return AgentChannelsResponseSchema.parse(await port.listAgentChannels(agentId))
  })

  app.get('/api/agents/:agentId/memory', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    return MemoryPageSchema.parse(
      await port.listMemory(agentId, MemoryQuerySchema.parse(request.query)),
    )
  })
  app.post('/api/agents/:agentId/memory', mutation, async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    const { text } = AddMemorySchema.parse(request.body)
    const item = await port.addMemory(agentId, text)
    await announce(agentId)
    return item
  })
  app.delete('/api/agents/:agentId/memory/:id', mutation, async (request) => {
    const { agentId, id } = AgentParams.extend({ id: MemoryIdSchema }).parse(request.params)
    await port.deleteMemory(agentId, id)
    await announce(agentId)
    return { id }
  })

  app.patch('/api/agents/:agentId/tools/:toolId', mutation, async (request) => {
    const { agentId, toolId } = AgentParams.extend({ toolId: ToolIdSchema }).parse(request.params)
    const { enabled } = PatchToolSchema.parse(request.body)
    const tool = await port.setToolEnabled(agentId, toolId, enabled)
    await announce(agentId)
    return tool
  })
}

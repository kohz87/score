import {
  MCP_POSTS_PER_HOUR,
  McpAccessPatchSchema,
  McpAccessSchema,
  McpReloadResultSchema,
  McpTokenIssuedSchema,
  type McpAccess,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import { mcpAddCommand } from '../hermes/index.ts'
import { MCP_PATH } from '../mcp/routes.ts'
import type { McpAccessStore } from '../mcp/access.ts'
import type { ScoreDb } from '../db/index.ts'
import { gatewayRestartBlocker } from '../domain/gateway-restart.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })

// Contract §13: the per-agent MCP switches and token (Team › agent › Tools). The MCP server itself is on the bridge listener.
export function registerMcpAccessRoutes(
  app: FastifyInstance,
  deps: {
    access: McpAccessStore
    bridgePort: number | undefined
    db: ScoreDb
    port: Pick<HermesPort, 'restartGateway'>
  },
): void {
  const { access, bridgePort, db, port } = deps
  // One restart at a time, for any agent: every profile runs in the same shared gateway, and `default` restarts it all.
  let restarting = false
  const view = (agentId: string): McpAccess => {
    const state = access.get(agentId)
    const url = bridgePort === undefined ? null : `http://127.0.0.1:${bridgePort}${MCP_PATH}`
    return McpAccessSchema.parse({
      agentId,
      enabled: state.enabled,
      writesEnabled: state.writesEnabled,
      hasToken: state.hasToken,
      tokenCreatedAt:
        state.tokenCreatedAt === null ? null : new Date(state.tokenCreatedAt).toISOString(),
      available: url !== null,
      url,
      command: url === null ? null : mcpAddCommand(agentId, url),
      postsThisHour: access.postsLastHour(agentId),
      postLimitPerHour: MCP_POSTS_PER_HOUR,
    })
  }
  const guard = { preHandler: [humanGuard(app.pairing)] }

  app.get('/api/agents/:agentId/mcp', async (request) =>
    view(ParamsSchema.parse(request.params).agentId),
  )
  app.put('/api/agents/:agentId/mcp', guard, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const change = McpAccessPatchSchema.parse(request.body)
    access.patch(agentId, {
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.writesEnabled === undefined ? {} : { writesEnabled: change.writesEnabled }),
    })
    return view(agentId)
  })
  // Creates or rotates. The token is in this response only.
  app.post('/api/agents/:agentId/mcp/token', guard, async (request, reply) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const token = access.issueToken(agentId)
    void reply.header('cache-control', 'no-store')
    return McpTokenIssuedSchema.parse({ token, access: view(agentId) })
  })
  app.delete('/api/agents/:agentId/mcp/token', guard, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    access.revokeToken(agentId)
    return view(agentId)
  })
  // 3.7.9 (decision 140): Reload MCP = restart the agent's gateway, only while Score sees nothing in flight there.
  app.post('/api/agents/:agentId/mcp/reload', guard, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const shared = agentId === 'default'
    const blocker = db.read((sqlite) => gatewayRestartBlocker(sqlite, shared ? null : agentId))
    if (blocker) throw new HttpError(409, 'agent_busy', blocker)
    if (restarting)
      throw new HttpError(409, 'agent_busy', 'A reload is already running. Try again in a moment.')
    restarting = true
    try {
      await port.restartGateway(agentId)
    } finally {
      restarting = false
    }
    return McpReloadResultSchema.parse({ agentId, scope: shared ? 'gateway' : 'profile' })
  })
}

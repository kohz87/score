import {
  MCP_POSTS_PER_HOUR,
  McpAccessPatchSchema,
  McpAccessSchema,
  McpTokenIssuedSchema,
  type McpAccess,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import { mcpAddCommand } from '../hermes/mcp-command.ts'
import { MCP_PATH } from '../mcp/routes.ts'
import type { McpAccessStore } from '../mcp/access.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })

// Contract §13: the per-agent MCP switches and token (Team › agent › Tools). The MCP server itself is on the bridge listener.
export function registerMcpAccessRoutes(
  app: FastifyInstance,
  deps: { access: McpAccessStore; bridgePort: number | undefined },
): void {
  const { access, bridgePort } = deps
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
}

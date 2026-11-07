import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { ApprovalOutbox } from './domain/approval-outbox.ts'
import { registerErrorHandlers } from './errors.ts'
import { registerMcpRoutes, type McpRouteDeps } from './mcp/routes.ts'
import { registerBridgeRoutes, type BridgeDeps } from './hermes/index.ts'

export function buildBridgeApp(
  bridge?: BridgeDeps,
  outbox?: ApprovalOutbox,
  logger: FastifyServerOptions['logger'] = false,
  /** Score's MCP server for agents (7.4d): served here, on the loopback bridge listener, and nowhere else. */
  mcp?: McpRouteDeps,
): FastifyInstance {
  const app = Fastify({ logger, trustProxy: false, forceCloseConnections: true })
  registerErrorHandlers(app)
  app.addHook('onRequest', async (request, reply) => {
    if (request.ip !== '127.0.0.1' && request.ip !== '::1')
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Loopback listener only' } })
  })
  if (bridge) registerBridgeRoutes(app, { ...bridge, ...(outbox ? { outbox } : {}) })
  if (mcp) registerMcpRoutes(app, mcp)
  return app
}

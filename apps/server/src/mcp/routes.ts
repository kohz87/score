import { MCP_CALLS_PER_MINUTE } from '@score/contract'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance } from 'fastify'
import { HttpError } from '../errors.ts'
import { createMcpServer, type McpToolDeps } from './tools.ts'

export const MCP_PATH = '/bridge/mcp'
const MINUTE = 60_000

export type McpRouteDeps = McpToolDeps

const unauthorized = () => new HttpError(401, 'unauthorized', 'Invalid MCP token')

// Streamable HTTP, stateless: every POST gets its own server and transport, and answers with plain JSON. Registered on the
// loopback bridge listener only (buildBridgeApp), never on the browser listener. An MCP token opens nothing else: the
// bridge routes and /api reject its format, and this route accepts no other token kind.
export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  const { access } = deps
  const calls = new Map<string, number[]>()
  // The Host names the loopback address; a rebinding page reaches this port under its own name.
  const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i

  // Per-agent request budget on top of the post budget, so a looping agent cannot flood reads either.
  function takeCall(agentId: string): void {
    const now = Date.now()
    const recent = (calls.get(agentId) ?? []).filter((at) => at > now - MINUTE)
    if (recent.length >= MCP_CALLS_PER_MINUTE)
      throw new HttpError(429, 'rate_limited', 'Too many MCP requests; slow down', {
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + MINUTE - now) / 1000)),
      })
    recent.push(now)
    calls.set(agentId, recent)
  }

  app.route({
    method: ['GET', 'DELETE'],
    url: MCP_PATH,
    handler: async (_request, reply) =>
      reply
        .code(405)
        .header('allow', 'POST')
        .send({
          error: { code: 'method_not_allowed', message: 'This MCP server is stateless: POST only' },
        }),
  })

  app.post(MCP_PATH, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    // Against DNS rebinding and browsers: MCP clients are not browsers, so a request with an Origin is refused.
    if (request.headers.origin !== undefined || !loopbackHost.test(request.headers.host ?? ''))
      throw new HttpError(403, 'forbidden', 'Not an MCP client request')
    const header = request.headers.authorization
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null
    const identity = match ? access.agentForToken(match[1]!) : undefined
    if (!identity) throw unauthorized()
    if (!access.get(identity.agentId).enabled)
      throw new HttpError(403, 'mcp_off', 'MCP access is turned off for this agent in Score')
    takeCall(identity.agentId)

    const server = createMcpServer(identity.agentId, deps)
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id, and JSON instead of an event stream.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    } catch (error) {
      request.log.error({ err: error }, 'mcp request failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(
          JSON.stringify({ error: { code: 'internal', message: 'MCP request failed' } }),
        )
      }
    }
  })
}

// An MCP token is not a credential for the browser API. Rejecting its format up front (even where /api would otherwise
// answer without credentials, as in local mode) means it can never be mistaken for, or smuggled into, another kind.
export function registerMcpCredentialGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    const path = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? ''
    if (!path.startsWith('/api/') && path !== '/api') return
    if (/^Bearer\s+scm_/i.test(request.headers.authorization ?? '')) throw unauthorized()
  })
}

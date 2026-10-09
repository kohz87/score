import {
  BridgeKnowledgeAppendRequestSchema,
  BridgeKnowledgeListRequestSchema,
  BridgeKnowledgeListResponseSchema,
  BridgeKnowledgeReadRequestSchema,
  BridgeKnowledgeReadResponseSchema,
  BridgeKnowledgeSearchRequestSchema,
  BridgeKnowledgeSearchResponseSchema,
  BridgeKnowledgeWriteRequestSchema,
  BridgeKnowledgeWriteResponseSchema,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { KnowledgeAgentApi } from '../../knowledge/agent-api.ts'
import type { Producer } from './registry.ts'

// Contract §11 "Knowledge tools". The agent is the authenticated producer's profile; bodies never name one.
export function registerBridgeKnowledgeRoutes(
  app: FastifyInstance,
  deps: { api: KnowledgeAgentApi; authenticate(value: unknown): Producer },
): void {
  const { api, authenticate } = deps
  const options = {
    // Two bodies of up to 256 KiB, escaped, plus the envelope.
    bodyLimit: 2 * 1024 * 1024,
    onRequest: async (request: { headers: { authorization?: string } }) => {
      authenticate(request.headers.authorization)
    },
  }
  const agent = (request: { headers: { authorization?: string } }) =>
    authenticate(request.headers.authorization).profile

  app.post('/bridge/v1/knowledge/search', options, async (request) => {
    const body = BridgeKnowledgeSearchRequestSchema.parse(request.body)
    return BridgeKnowledgeSearchResponseSchema.parse(
      api.search(agent(request), body.query, body.limit),
    )
  })
  app.post('/bridge/v1/knowledge/read', options, async (request) => {
    const body = BridgeKnowledgeReadRequestSchema.parse(request.body)
    return BridgeKnowledgeReadResponseSchema.parse(await api.read(agent(request), body.path))
  })
  app.post('/bridge/v1/knowledge/list', options, async (request) => {
    const body = BridgeKnowledgeListRequestSchema.parse(request.body)
    return BridgeKnowledgeListResponseSchema.parse(await api.list(agent(request), body.folder))
  })
  app.post('/bridge/v1/knowledge/write', options, async (request) => {
    const body = BridgeKnowledgeWriteRequestSchema.parse(request.body)
    return BridgeKnowledgeWriteResponseSchema.parse(
      await api.write(agent(request), body.path, body.body, body.expectedEtag),
    )
  })
  app.post('/bridge/v1/knowledge/append', options, async (request) => {
    const body = BridgeKnowledgeAppendRequestSchema.parse(request.body)
    return BridgeKnowledgeWriteResponseSchema.parse(
      await api.append(agent(request), body.path, body.text),
    )
  })
}

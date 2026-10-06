import Fastify, { type FastifyInstance } from 'fastify'
import { CONTRACT_VERSION } from '@score/contract'

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' })
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  return app
}

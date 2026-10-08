import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sessionCookie } from '../auth/cookies.ts'
import type { PairingService } from '../auth/pairing.ts'
import { humanGuard } from '../auth/human.ts'

const PairBodySchema = z.object({ token: z.string().max(256) })

export function registerSessionRoutes(
  app: FastifyInstance,
  pairing: PairingService,
  secure = false,
): void {
  app.post('/api/session/pair', async (request, reply) => {
    const { token } = PairBodySchema.parse(request.body)
    const id = pairing.pair(token, request.ip, request.headers['user-agent'] ?? 'Browser')
    return reply
      .header('set-cookie', sessionCookie(id, undefined, secure))
      .code(204)
      .send()
  })

  app.get('/api/session', async (request) => ({
    paired: pairing.isPaired(request.headers.cookie),
  }))

  app.delete('/api/session', async (request, reply) => {
    pairing.revoke(request.headers.cookie)
    return reply
      .header('set-cookie', sessionCookie('', 0, secure))
      .code(204)
      .send()
  })

  // Paired browsers only, in every mode (the remote guard isn't active locally). Ids are not credentials.
  app.get('/api/session/browsers', { preHandler: humanGuard(pairing) }, async (request) => ({
    items: app.pairing.browsers(request.headers.cookie),
  }))

  app.delete(
    '/api/session/browsers/:id',
    { preHandler: humanGuard(pairing) },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params)
      app.pairing.revokeBrowser(id)
      return reply.code(204).send()
    },
  )
}

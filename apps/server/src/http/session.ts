import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sessionCookie } from '../auth/cookies.ts'
import type { PairingService } from '../auth/pairing.ts'

const PairBodySchema = z.object({ token: z.string() })

export function registerSessionRoutes(app: FastifyInstance, pairing: PairingService): void {
  app.post('/api/session/pair', async (request, reply) => {
    const { token } = PairBodySchema.parse(request.body)
    const id = pairing.pair(token)
    return reply.header('set-cookie', sessionCookie(id)).code(204).send()
  })

  app.get('/api/session', async (request) => ({
    paired: pairing.isPaired(request.headers.cookie),
  }))

  app.delete('/api/session', async (request, reply) => {
    pairing.revoke(request.headers.cookie)
    return reply.header('set-cookie', sessionCookie('', 0)).code(204).send()
  })
}

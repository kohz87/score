import type { FastifyInstance } from 'fastify'
import { SystemStatusSchema, type SystemStatus } from '@score/contract'

export function registerSystemRoutes(
  app: FastifyInstance,
  getSystemStatus: () => SystemStatus,
): void {
  app.get('/api/system', async () => SystemStatusSchema.parse(getSystemStatus()))
}

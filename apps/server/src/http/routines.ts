import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { CreateRoutineSchema, PatchRoutineSchema, type HermesPort } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { assertAgentAdmits } from '../domain/agent-lifecycle.ts'

const AgentParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const RoutineParamsSchema = z.object({ routineId: z.string().min(1).max(256) })
const KeySchema = z.string().regex(/^[\x21-\x7e]{1,256}$/)

export function registerRoutineRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  app.get('/api/agents/:agentId/routines', async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params)
    return { items: await port.listRoutines(agentId) }
  })
  app.post('/api/agents/:agentId/routines', mutation, async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params)
    if (db) assertAgentAdmits(db.sqlite, agentId)
    const req = CreateRoutineSchema.parse(request.body)
    const key = KeySchema.parse(request.headers['idempotency-key'] ?? randomUUID())
    return port.createRoutine(agentId, req, key)
  })
  app.patch('/api/routines/:routineId', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    return port.patchRoutine(routineId, PatchRoutineSchema.parse(request.body))
  })
  app.delete('/api/routines/:routineId', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    await port.deleteRoutine(routineId)
    return { id: routineId }
  })
  app.post('/api/routines/:routineId/run', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    if (db) assertAgentAdmits(db.sqlite, routineId.split(':', 1)[0]!)
    await port.runRoutine(routineId)
    return { id: routineId, queued: true }
  })
}

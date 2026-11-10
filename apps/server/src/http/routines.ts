import {
  MoveRepeatingJobSchema,
  MovedRepeatingJobSchema,
  RepeatingJobsResponseSchema,
  RoutinesPinnedSchema,
  type RepeatingJob,
  type RoutineSummary,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { CreateRoutineSchema, PatchRoutineSchema, type HermesPort } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { agentPausedAt, assertAgentAdmits } from '../domain/agent-lifecycle.ts'
import { teamPausedAt } from '../domain/team-pause.ts'
import { HttpError } from '../errors.ts'
import { moveTarget, repeatingJob, retitleTarget, setTarget } from '../domain/routine-targets.ts'

const AgentParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const RoutineParamsSchema = z.object({ routineId: z.string().min(1).max(256) })
const KeySchema = z.string().regex(/^[\x21-\x7e]{1,256}$/)

export function registerRoutineRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const stamp = () => new Date(clock()).toISOString()
  const asJob = (one: RoutineSummary): RepeatingJob => ({
    ...one,
    agentId: one.id.split(':', 1)[0]!,
    nextRunAt: one.nextRunAt ?? null,
    provider: one.provider ?? null,
    deliverTo: null,
  })
  // Where results go is checked before Hermes changes anything, so a bad chat never leaves a half-made change.
  const assertChat = (roomId: string | null | undefined) => {
    if (
      db &&
      roomId &&
      !db.read((sqlite) => sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId))
    )
      throw new HttpError(400, 'bad_request', 'Couldn’t find that chat.')
  }
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
    assertChat(req.deliverTo)
    const made = await port.createRoutine(agentId, req, key)
    // Decision 183: where its results go is Score's own.
    if (db && req.deliverTo)
      db.tx((sqlite) => setTarget(sqlite, made.id, req.deliverTo!, made.title, stamp()))
    return db ? db.read((sqlite) => repeatingJob(sqlite, made)) : made
  })
  // Decision 183: every agent's repeating jobs, for Tasks › Repeating; an agent whose jobs can't be read is named.
  app.get('/api/routines', async () => {
    const agents = (await port.listAgents()).filter(
      (agent) => !agent.runtime || agent.runtime === 'hermes',
    )
    const items: RepeatingJob[] = []
    const unreadable: string[] = []
    for (const agent of agents)
      try {
        const listed = await port.listRoutines(agent.id)
        items.push(
          ...listed.map((one) =>
            db ? db.read((sqlite) => repeatingJob(sqlite, one)) : asJob(one),
          ),
        )
      } catch {
        unreadable.push(agent.id)
      }
    return RepeatingJobsResponseSchema.parse({ items, unreadable })
  })
  app.post('/api/routines/:routineId/move', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    const { agentId } = MoveRepeatingJobSchema.parse(request.body)
    if (db) assertAgentAdmits(db.sqlite, agentId)
    const key = KeySchema.parse(request.headers['idempotency-key'] ?? randomUUID())
    const moved = await port.moveRoutine(routineId, agentId, key)
    // Results follow the job, also when the old copy is still there (the person removes it).
    if (db && moved.job.id !== routineId)
      db.tx((sqlite) => moveTarget(sqlite, routineId, moved.job.id, stamp()))
    return MovedRepeatingJobSchema.parse({
      job: db ? db.read((sqlite) => repeatingJob(sqlite, moved.job)) : asJob(moved.job),
      leftBehind: moved.leftBehind,
    })
  })
  // Decision 182: before the agent's model changes, keep its following jobs on the model it has now.
  app.post('/api/agents/:agentId/routines/pin', mutation, async (request) => {
    const { agentId } = AgentParamsSchema.parse(request.params)
    return RoutinesPinnedSchema.parse({ pinned: await port.pinFollowingRoutines(agentId) })
  })
  app.patch('/api/routines/:routineId', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    const req = PatchRoutineSchema.parse(request.body)
    assertChat(req.deliverTo)
    const patched = await port.patchRoutine(routineId, req)
    if (!db) return patched
    db.tx((sqlite) => {
      if (req.deliverTo !== undefined)
        setTarget(sqlite, routineId, req.deliverTo, patched.title, stamp())
      else if (req.title !== undefined) retitleTarget(sqlite, routineId, patched.title)
    })
    return db.read((sqlite) => repeatingJob(sqlite, patched))
  })
  app.delete('/api/routines/:routineId', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    await port.deleteRoutine(routineId)
    return { id: routineId }
  })
  app.post('/api/routines/:routineId/run', mutation, async (request) => {
    const { routineId } = RoutineParamsSchema.parse(request.params)
    if (db) {
      const agentId = routineId.split(':', 1)[0]!
      assertAgentAdmits(db.sqlite, agentId)
      // A routine started by hand is work like any other: the holds apply.
      if (teamPausedAt(db.sqlite) !== null || agentPausedAt(db.sqlite, agentId) !== null)
        throw new HttpError(
          409,
          'paused',
          'Work is paused. Resume the team or the agent before running a routine.',
        )
    }
    await port.runRoutine(routineId)
    return { id: routineId, queued: true }
  })
}

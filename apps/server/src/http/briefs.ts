import type { BriefSummary } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { activeRunOfNode, readBriefFlow, readBriefLog, readFlowNode } from '../domain/brief-flow.ts'
import { briefSummary, listBriefs, requireBrief } from '../domain/briefs.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import {
  assertBriefFree,
  assertNotOwned,
  assertRoomFree,
  briefOfRun,
  ownerOfBrief,
} from '../domain/orchestration/ownership.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import type { BriefControl } from './brief-control.ts'
import { requestIdempotency } from './idempotency.ts'
import type { PlanStarter } from './plan-start.ts'

const BriefParams = z.object({ briefId: z.string().min(1).max(256) })
const NodeParams = z.object({ nodeId: z.string().min(1).max(512) })
const PlanParams = z.object({
  roomId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
})
const ListQuery = z.object({ status: z.enum(['active', 'recent']).default('active') }).strict()
const LogQuery = z
  .object({
    agent: z.string().min(1).max(256).optional(),
    kind: z.enum(['tool', 'all']).default('all'),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict()

export function registerBriefRoutes(
  app: FastifyInstance,
  deps: {
    port: HermesPort
    db: ScoreDb
    ingest: Ingest
    control: BriefControl
    plans: PlanStarter
    /** Brief pause / resume of an orchestration's brief are delegated to the run (contract §14). */
    orchestrator?: Orchestrator
    clock?: () => number
  },
): void {
  const { port, db, control, plans, orchestrator } = deps
  const clock = deps.clock ?? Date.now
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  const summaryOf = (briefId: string): BriefSummary =>
    db.read((sqlite) => briefSummary(sqlite, requireBrief(sqlite, briefId)))

  app.get('/api/briefs', async (request) => {
    const query = ListQuery.parse(request.query)
    return { items: db.read((sqlite) => listBriefs(sqlite, query.status, clock())) }
  })

  app.get('/api/briefs/:briefId/flow', async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    const result = snapshot(db, (sqlite) => readBriefFlow(sqlite, briefId, clock()))
    return { asOfSeq: result.asOfSeq, ...result.data }
  })

  app.get('/api/flow/nodes/:nodeId', async (request) => {
    const { nodeId } = NodeParams.parse(request.params)
    return db.read((sqlite) => readFlowNode(sqlite, nodeId, clock()))
  })

  app.get('/api/briefs/:briefId/log', async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    const query = LogQuery.parse(request.query)
    return db.read((sqlite) => readBriefLog(sqlite, briefId, query))
  })

  app.post('/api/briefs/:briefId/pause', mutation, async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    const owner = db.read((sqlite) => ownerOfBrief(sqlite, briefId))
    if (owner) {
      assertNotOwned(owner.state === 'owned' ? undefined : owner, 'brief.pause')
      await orchestrator?.pause(owner.orchestration.id, {
        orchestrationRevision: owner.orchestration.revision,
      })
      return summaryOf(briefId)
    }
    await control.pause(briefId)
    return summaryOf(briefId)
  })

  app.post('/api/briefs/:briefId/resume', mutation, async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    const owner = db.read((sqlite) => ownerOfBrief(sqlite, briefId))
    if (owner) {
      assertNotOwned(owner.state === 'owned' ? undefined : owner, 'brief.resume')
      await orchestrator?.resume(owner.orchestration.id, {
        orchestrationRevision: owner.orchestration.revision,
      })
      return summaryOf(briefId)
    }
    await control.resume(briefId)
    return summaryOf(briefId)
  })

  app.post('/api/flow/nodes/:nodeId/stop', mutation, async (request) => {
    const { nodeId } = NodeParams.parse(request.params)
    const run = db.read((sqlite) => {
      const found = activeRunOfNode(sqlite, nodeId)
      const briefId = briefOfRun(sqlite, found.runId)
      if (briefId) assertBriefFree(sqlite, briefId, 'flow.stop')
      return found
    })
    await port.stopRun(run)
    return { ok: true }
  })

  // Start plan (H): the only thing that turns a proposed plan into tasks. Durable and idempotent per step
  // (plan-start.ts): a repeated start, or a restart, resumes where the last one stopped.
  app.post('/api/rooms/:roomId/messages/:messageId/plan/start', mutation, (request) => {
    const { roomId, messageId } = PlanParams.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'plan.start'))
    return plans.start(roomId, messageId)
  })
}

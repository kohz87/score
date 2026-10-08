import { randomUUID } from 'node:crypto'
import type { BriefSummary, PlanStartResponse } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { activeRunOfNode, readBriefFlow, readBriefLog, readFlowNode } from '../domain/brief-flow.ts'
import {
  briefSummary,
  emitBriefChange,
  linkTasks,
  listBriefs,
  readBriefRow,
  requireBrief,
} from '../domain/briefs.ts'
import { orderedPlanSteps } from '../domain/plan.ts'
import { messageFromRow } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { redact } from '../redact.ts'
import type { BriefControl } from './brief-control.ts'
import { requestIdempotency } from './idempotency.ts'

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
    clock?: () => number
  },
): void {
  const { port, db, ingest, control } = deps
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
    await control.pause(briefId)
    return summaryOf(briefId)
  })

  app.post('/api/briefs/:briefId/resume', mutation, async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    await control.resume(briefId)
    return summaryOf(briefId)
  })

  app.post('/api/flow/nodes/:nodeId/stop', mutation, async (request) => {
    const { nodeId } = NodeParams.parse(request.params)
    const run = db.read((sqlite) => activeRunOfNode(sqlite, nodeId))
    await port.stopRun(run)
    return { ok: true }
  })

  // Start plan (H): the only thing that turns a proposed plan into tasks. Step keys make it idempotent.
  app.post('/api/rooms/:roomId/messages/:messageId/plan/start', mutation, async (request) => {
    const { roomId, messageId } = PlanParams.parse(request.params)
    const found = db.read((sqlite) => {
      const row = sqlite
        .prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
        .get(messageId, roomId)
      if (row === undefined) throw new HttpError(404, 'not_found', 'Unknown message')
      const message = messageFromRow(row)
      const part = message.parts.find((item) => item.kind === 'plan')
      if (!part) throw new HttpError(400, 'bad_request', 'This message has no plan')
      if (message.streaming) throw new HttpError(409, 'conflict', 'The plan is still being written')
      const brief = readBriefRow(sqlite, part.briefId)
      if (!brief) throw new HttpError(404, 'not_found', 'Unknown brief')
      return { part, brief }
    })
    const steps = orderedPlanSteps(found.part)
    if (!steps.length) throw new HttpError(400, 'bad_request', 'The plan has no steps to start')
    const taskIds: string[] = []
    for (const step of steps) {
      const task = await port.createTask(
        {
          title: step.title,
          assignee: step.agentId,
          roomId,
          body: `Step ${step.index + 1} of the plan for: ${redact(found.brief.title)}`,
          ...(taskIds.length ? { dependsOn: [taskIds.at(-1)!] } : {}),
        },
        `plan:${messageId}:${step.index}`,
      )
      taskIds.push(task.id)
    }
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        linkTasks(
          sqlite,
          found.brief.id,
          taskIds.map((taskId) => ({ taskId, origin: 'plan' as const })),
          now,
        )
        sqlite
          .prepare(
            `INSERT INTO brief_plan_starts (message_id, brief_id, started_at) VALUES (?, ?, ?)
             ON CONFLICT DO NOTHING`,
          )
          .run(messageId, found.brief.id, now)
        return emitBriefChange(sqlite, found.brief.id, true)
      },
    })
    const response: PlanStartResponse = { briefId: found.brief.id, taskIds }
    return response
  })
}

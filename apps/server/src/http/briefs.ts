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
import { withKeyedLock } from '../keyed-lock.ts'
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
  app.post('/api/rooms/:roomId/messages/:messageId/plan/start', mutation, (request) => {
    const { roomId, messageId } = PlanParams.parse(request.params)
    // Two starts of one plan (different HTTP keys) must run one after the other and share the step tasks.
    return withKeyedLock(`plan-start:${messageId}`, () => startPlan(roomId, messageId))
  })
  const startPlan = async (roomId: string, messageId: string): Promise<PlanStartResponse> => {
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
      // New tasks would run while the brief claims to be paused, and Pause only holds tasks that exist.
      if (brief.paused_at !== null)
        throw new HttpError(409, 'conflict', 'Resume the brief before starting its plan')
      return { part, brief }
    })
    const steps = orderedPlanSteps(found.part)
    if (!steps.length) throw new HttpError(400, 'bad_request', 'The plan has no steps to start')
    const taskIds: string[] = []
    const link = (taskId: string, record: boolean) =>
      ingest.submit({
        source: 'briefs',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          linkTasks(sqlite, found.brief.id, [{ taskId, origin: 'plan' as const }], now)
          // A step linked earlier may already have claimed this one as its dependency child.
          sqlite
            .prepare(
              "UPDATE brief_tasks SET origin = 'plan' WHERE brief_id = ? AND task_id = ? AND origin = 'child'",
            )
            .run(found.brief.id, taskId)
          if (record)
            sqlite
              .prepare(
                `INSERT INTO brief_plan_starts (message_id, brief_id, started_at) VALUES (?, ?, ?)
                 ON CONFLICT DO NOTHING`,
              )
              .run(messageId, found.brief.id, now)
          return emitBriefChange(sqlite, found.brief.id, true)
        },
      })
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
      // Link at once: a later step failing must not leave a running task outside its brief.
      await link(task.id, taskIds.length === steps.length)
    }
    const response: PlanStartResponse = { briefId: found.brief.id, taskIds }
    return response
  }
}

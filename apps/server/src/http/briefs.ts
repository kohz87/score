import { randomUUID } from 'node:crypto'
import type { BriefSummary, PlanStartResponse } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { activeRunOfNode, readBriefFlow, readBriefLog, readFlowNode } from '../domain/brief-flow.ts'
import {
  briefSummary,
  briefTasks,
  emitBriefChange,
  linkTasks,
  listBriefs,
  readBriefRow,
  requireBrief,
  taskStatus,
} from '../domain/briefs.ts'
import { orderedPlanSteps } from '../domain/plan.ts'
import { messageFromRow } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { redact } from '../redact.ts'
import { requestIdempotency } from './idempotency.ts'

const NOT_STARTED = ['triage', 'todo', 'scheduled', 'ready']
const PAUSE_REASON = 'Paused from Score'
const RESUME_REASON = 'Resumed from Score'

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
    /** Wakes the room queue after a resume instead of waiting for its periodic sweep. */
    dispatch?: () => Promise<void>
    clock?: () => number
  },
): void {
  const { port, db, ingest, dispatch } = deps
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

  // Pause cannot suspend a running Hermes turn. It holds Score's own queue for the brief and blocks the tasks
  // that have not started; steps already running finish.
  app.post('/api/briefs/:briefId/pause', mutation, async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    let candidates: string[] = []
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const row = requireBrief(sqlite, briefId)
        if (row.paused_at === null)
          sqlite.prepare('UPDATE briefs SET paused_at = ? WHERE id = ?').run(now, briefId)
        // The row is written before the block is attempted, so a crash never forgets what Score touched.
        candidates = briefTasks(sqlite, briefId)
          .filter(({ detail }) => detail && NOT_STARTED.includes(taskStatus(detail)))
          .map(({ taskId }) => taskId)
          .filter(
            (taskId) =>
              sqlite
                .prepare('SELECT 1 FROM brief_paused_tasks WHERE brief_id = ? AND task_id = ?')
                .get(briefId, taskId) === undefined,
          )
        for (const taskId of candidates)
          sqlite
            .prepare(
              'INSERT INTO brief_paused_tasks (brief_id, task_id, blocked_at) VALUES (?, ?, ?)',
            )
            .run(briefId, taskId, now)
        return emitBriefChange(sqlite, briefId, true)
      },
    })
    for (const taskId of candidates) {
      try {
        await port.taskAction({ taskId, action: 'block', text: PAUSE_REASON })
      } catch {
        // Not blocked: forget it so Resume never touches a task Score did not block.
        await forget(briefId, taskId)
      }
    }
    return summaryOf(briefId)
  })

  async function forget(briefId: string, taskId: string): Promise<void> {
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite }) {
        sqlite
          .prepare('DELETE FROM brief_paused_tasks WHERE brief_id = ? AND task_id = ?')
          .run(briefId, taskId)
        return []
      },
    })
  }

  app.post('/api/briefs/:briefId/resume', mutation, async (request) => {
    const { briefId } = BriefParams.parse(request.params)
    let ours: string[] = []
    await ingest.submit({
      source: 'briefs',
      identity: randomUUID(),
      apply({ sqlite }) {
        requireBrief(sqlite, briefId)
        sqlite.prepare('UPDATE briefs SET paused_at = NULL WHERE id = ?').run(briefId)
        ours = z
          .array(z.object({ task_id: z.string() }))
          .parse(
            sqlite
              .prepare('SELECT task_id FROM brief_paused_tasks WHERE brief_id = ? ORDER BY rowid')
              .all(briefId),
          )
          .map((row) => row.task_id)
        return emitBriefChange(sqlite, briefId, true)
      },
    })
    await dispatch?.()
    const failed: string[] = []
    for (const taskId of ours) {
      try {
        // Only what Score blocked, and only if it is still blocked (the person may have moved it since).
        const task = await port.getTask(taskId).catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 404) return undefined
          throw error
        })
        if (task && taskStatus(task) === 'blocked')
          await port.taskAction({ taskId, action: 'unblock', text: RESUME_REASON })
        await forget(briefId, taskId)
      } catch {
        failed.push(taskId)
      }
    }
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Resumed, but some tasks could not be unblocked. Try Resume again.',
        { taskIds: failed },
      )
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

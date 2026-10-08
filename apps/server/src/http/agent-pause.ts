import { AgentDetailSchema, AgentSummarySchema, TaskDetailSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { agentPausedAt } from '../domain/agent-lifecycle.ts'
import { readAgent, reconcileAgents } from '../domain/agents.ts'
import { taskStatus } from '../domain/briefs.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const NOT_STARTED = ['triage', 'todo', 'scheduled', 'ready']
const PAUSE_REASON = 'Paused from Score'
const RESUME_REASON = 'Resumed from Score'
const TaskIdRow = z.object({ task_id: z.string() })
const DetailRow = z.object({ detail: z.string() })

// Pause <agent> (H): same semantics as pausing a brief. It cannot suspend a running Hermes turn; it holds Score's
// dispatch queue for the agent and blocks the agent's not-started Kanban tasks. Resume unblocks only those.
export function registerAgentPauseRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    dispatch?: () => Promise<void>
    clock?: () => number
  },
): void {
  const { db, ingest, port, dispatch } = deps
  const receipts = requestIdempotency(db, deps.clock ?? Date.now)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  // Re-reading the agents re-applies the pause overlay, so the status flips and agent.updated goes out.
  async function refresh(agentId: string) {
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await reconcileAgents(ingest, details)
    const agent = db.read((sqlite) => readAgent(sqlite, agentId))
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found')
    return AgentSummarySchema.parse(agent)
  }

  async function forget(agentId: string, taskId: string): Promise<void> {
    await ingest.submit({
      source: 'agent-pause',
      identity: randomUUID(),
      apply({ sqlite }) {
        sqlite
          .prepare('DELETE FROM agent_paused_tasks WHERE agent_id = ? AND task_id = ?')
          .run(agentId, taskId)
        return []
      },
    })
  }

  app.post('/api/agents/:agentId/pause', mutation, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    await refresh(agentId)
    let candidates: string[] = []
    await ingest.submit({
      source: 'agent-pause',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        if (agentPausedAt(sqlite, agentId) === null)
          sqlite
            .prepare('INSERT INTO agent_pauses (agent_id, paused_at) VALUES (?, ?)')
            .run(agentId, now)
        // Written before the block is attempted, so a crash never forgets what Score touched.
        candidates = z
          .array(DetailRow)
          .parse(sqlite.prepare('SELECT detail FROM task_projections').all())
          .map((row) => TaskDetailSchema.parse(JSON.parse(row.detail)))
          .filter((task) => task.assignee === agentId && NOT_STARTED.includes(taskStatus(task)))
          .map((task) => task.id)
          .filter(
            (taskId) =>
              sqlite
                .prepare('SELECT 1 FROM agent_paused_tasks WHERE agent_id = ? AND task_id = ?')
                .get(agentId, taskId) === undefined,
          )
        for (const taskId of candidates)
          sqlite
            .prepare(
              'INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at) VALUES (?, ?, ?)',
            )
            .run(agentId, taskId, now)
        return []
      },
    })
    for (const taskId of candidates) {
      try {
        await port.taskAction({ taskId, action: 'block', text: PAUSE_REASON })
      } catch {
        // Not blocked: forget it so Resume never touches a task Score did not block.
        await forget(agentId, taskId)
      }
    }
    return refresh(agentId)
  })

  app.post('/api/agents/:agentId/resume', mutation, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    await refresh(agentId)
    let ours: string[] = []
    await ingest.submit({
      source: 'agent-pause',
      identity: randomUUID(),
      apply({ sqlite }) {
        sqlite.prepare('DELETE FROM agent_pauses WHERE agent_id = ?').run(agentId)
        ours = z
          .array(TaskIdRow)
          .parse(
            sqlite
              .prepare('SELECT task_id FROM agent_paused_tasks WHERE agent_id = ? ORDER BY rowid')
              .all(agentId),
          )
          .map((row) => row.task_id)
        return []
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
        await forget(agentId, taskId)
      } catch {
        failed.push(taskId)
      }
    }
    const agent = await refresh(agentId)
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Resumed, but some tasks could not be unblocked. Try Resume again.',
        { taskIds: failed },
      )
    return agent
  })
}

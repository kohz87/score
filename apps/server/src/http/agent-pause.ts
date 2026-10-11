import { AgentDetailSchema, AgentSummarySchema, TaskDetailSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import { agentPausedAt } from '../domain/agent-lifecycle.ts'
import { readAgent, reconcileAgents } from '../domain/agents.ts'
import { taskStatus } from '../domain/briefs.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'
import { holdable, recordHolds } from '../domain/holds.ts'
import type { TaskHolds } from './task-holds.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const DetailRow = z.object({ detail: z.string() })

// Pause <agent> (H): same semantics as pausing a brief. It cannot suspend a running Hermes turn; it holds Score's
// dispatch queue for the agent and parks the agent's not-started Kanban tasks. Resume unparks only those.
export function registerAgentPauseRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    holds: TaskHolds
    dispatch?: () => Promise<void>
    clock?: () => number
    orchestrator?: Pick<Orchestrator, 'recordHold'> &
      Partial<Pick<Orchestrator, 'admissionChanged'>>
  },
): void {
  const { db, ingest, port, holds, dispatch, orchestrator } = deps
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
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return AgentSummarySchema.parse(agent)
  }

  const isPaused = (agentId: string) => db.read((sqlite) => agentPausedAt(sqlite, agentId) !== null)

  app.post('/api/agents/:agentId/pause', mutation, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    await refresh(agentId)
    // Journaled first: an orchestration's admissions depend on this hold (fix-h item 2).
    orchestrator?.recordHold({ kind: 'agent', agentId }, 'set')
    await ingest.submit({
      source: 'agent-pause',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        if (agentPausedAt(sqlite, agentId) === null)
          sqlite
            .prepare('INSERT INTO agent_pauses (agent_id, paused_at) VALUES (?, ?)')
            .run(agentId, now)
        // Intent is written before Hermes is touched, so a crash or a refusal is retried, never forgotten.
        recordHolds(
          sqlite,
          { kind: 'agent', id: agentId },
          z
            .array(DetailRow)
            .parse(sqlite.prepare('SELECT detail FROM task_projections').all())
            .map((row) => TaskDetailSchema.parse(JSON.parse(row.detail)))
            .filter(
              (task) => task.assignee === agentId && holdable(sqlite, task.id, taskStatus(task)),
            )
            .map((task) => task.id),
          now,
        )
        return []
      },
    })
    const failed = await holds.apply({ kind: 'agent', id: agentId }, () => isPaused(agentId))
    const agent = await refresh(agentId)
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Paused, but some tasks couldn’t be held. Try Pause again.',
        { taskIds: failed },
      )
    return agent
  })

  app.post('/api/agents/:agentId/resume', mutation, async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    await refresh(agentId)
    orchestrator?.recordHold({ kind: 'agent', agentId }, 'lift')
    await ingest.submit({
      source: 'agent-pause',
      identity: randomUUID(),
      apply({ sqlite }) {
        sqlite.prepare('DELETE FROM agent_pauses WHERE agent_id = ?').run(agentId)
        return []
      },
    })
    await orchestrator?.admissionChanged?.()
    await dispatch?.()
    const failed = await holds.release({ kind: 'agent', id: agentId })
    const agent = await refresh(agentId)
    if (failed.length)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Resumed, but some tasks couldn’t be unblocked. Try Resume again.',
        { taskIds: failed },
      )
    return agent
  })
}

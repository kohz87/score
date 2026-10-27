import {
  AbandonDecisionSchema,
  GateDecisionSchema,
  LimitsDecisionSchema,
  QuotaDecisionSchema,
  RunControlSchema,
  WaiverDecisionSchema,
  type WorkflowDefinition,
  WorkflowCreateSchema,
  WorkflowDeleteWithRunsSchema,
  WorkflowExportRequestSchema,
  WorkflowPolicyRemapDecisionSchema,
  WorkflowRemapDecisionSchema,
  WorkflowRetryDecisionSchema,
  WorkflowRunCreateSchema,
  WorkflowTryAgainDecisionSchema,
  WorkflowValidateSchema,
  WorkflowVersionCreateSchema,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import {
  addVersion,
  createWorkflow,
  deleteWorkflow,
  deleteWorkflowWithRuns,
  exportVersion,
  getWorkflow,
  listWorkflows,
  readVersion,
  setWorkflowArchived,
} from '../domain/workflows/definitions.ts'
import type { HermesPort } from '../hermes/index.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import { requestIdempotency } from './idempotency.ts'

const IdParams = z.object({ id: z.string().min(1).max(100) })
const VersionParams = IdParams.extend({ version: z.coerce.number().int().positive() })
const GateParams = IdParams.extend({ gateId: z.string().min(1).max(100) })
const NodeParams = IdParams.extend({ nodeId: z.string().min(1).max(40) })
const PreflightQuery = z.object({
  workflowId: z.string().min(1).max(100),
  version: z.coerce.number().int().positive(),
})

// Contract §15. Definitions are plain data in Score's database; run mutations are H (paired session) and carry the
// run revision the page showed.
export function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: {
    orchestrator: Orchestrator
    db: ScoreDb
    ingest?: Ingest
    port: Pick<HermesPort, 'listAgents'>
    clock?: () => number
  },
): void {
  const { orchestrator, db } = deps
  const now = () => new Date((deps.clock ?? Date.now)()).toISOString()
  const receipts = requestIdempotency(db, deps.clock ?? Date.now, 300 * 1024)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  // ----- definitions
  app.get('/api/workflows', async () => db.read((sqlite) => listWorkflows(sqlite)))
  // One runtime validation for Validate, save, new versions and start (7.7c §1): the graph rules and the team and host
  // rules for coding agents.
  const validated = async (definition: WorkflowDefinition) =>
    orchestrator.validateWorkflow(definition, await deps.port.listAgents())
  const requireRunnable = async (definition: WorkflowDefinition): Promise<void> => {
    const result = await validated(definition)
    if (!result.ok)
      throw new HttpError(
        422,
        'invalid_definition',
        'The workflow has errors. Fix them and save again.',
        { result },
      )
  }
  app.post('/api/workflows/validate', async (request) =>
    validated(WorkflowValidateSchema.parse(request.body).definition),
  )
  app.get('/api/workflows/:id', async (request) =>
    db.read((sqlite) => getWorkflow(sqlite, IdParams.parse(request.params).id)),
  )
  app.get('/api/workflows/:id/versions/:version', async (request) => {
    const { id, version } = VersionParams.parse(request.params)
    return db.read((sqlite) => readVersion(sqlite, id, version))
  })
  app.post('/api/workflows', mutation, async (request, reply) => {
    const body = WorkflowCreateSchema.parse(request.body)
    await requireRunnable(body.definition)
    return reply.code(201).send(db.tx((sqlite) => createWorkflow(sqlite, body.definition, now())))
  })
  app.post('/api/workflows/:id/versions', mutation, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const body = WorkflowVersionCreateSchema.parse(request.body)
    await requireRunnable(body.definition)
    return reply
      .code(201)
      .send(db.tx((sqlite) => addVersion(sqlite, id, body.baseVersion, body.definition, now())))
  })
  app.delete('/api/workflows/:id', mutation, async (request, reply) => {
    db.tx((sqlite) => deleteWorkflow(sqlite, IdParams.parse(request.params).id))
    return reply.code(204).send()
  })
  // Archive (3.8.0): a recipe with runs is hidden, not deleted. Not streamed: the web refetches the list.
  for (const [action, archived] of [
    ['archive', true],
    ['unarchive', false],
  ] as const)
    app.post(`/api/workflows/:id/${action}`, mutation, async (request) =>
      db.tx((sqlite) =>
        setWorkflowArchived(sqlite, IdParams.parse(request.params).id, archived, now()),
      ),
    )
  app.post('/api/workflows/:id/delete-with-runs', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    const body = WorkflowDeleteWithRunsSchema.parse(request.body)
    let deletedRuns = 0
    const apply = ({ sqlite, now: at }: { sqlite: DatabaseSync; now: string }) => {
      const result = deleteWorkflowWithRuns(sqlite, id, body.confirm, at)
      deletedRuns = result.deletedRuns
      return result.events
    }
    if (deps.ingest)
      await deps.ingest.submit({ source: 'workflows', identity: randomUUID(), apply })
    else db.tx((sqlite) => apply({ sqlite, now: now() }))
    return { deletedRuns }
  })
  app.post('/api/workflows/:id/versions/:version/export', async (request) => {
    const { id, version } = VersionParams.parse(request.params)
    const body = WorkflowExportRequestSchema.parse(request.body ?? {})
    const agents = new Map((await deps.port.listAgents()).map((agent) => [agent.id, agent]))
    return exportVersion(
      db.read((sqlite) => readVersion(sqlite, id, version)),
      (agentId) => ({
        name: agents.get(agentId)?.name ?? agentId,
        role: agents.get(agentId)?.role ?? null,
      }),
      body.removePaths,
    )
  })

  // ----- runs
  app.get('/api/workflow-runs/preflight', async (request) => {
    const query = PreflightQuery.parse(request.query)
    return orchestrator.workflowPreflight(
      query.workflowId,
      query.version,
      await deps.port.listAgents(),
    )
  })
  app.get('/api/workflow-runs', async () => orchestrator.workflowRuns())
  app.post('/api/workflow-runs', mutation, async (request, reply) => {
    const body = WorkflowRunCreateSchema.parse(request.body)
    const created = await orchestrator.createWorkflowRun(body, await deps.port.listAgents())
    return reply.code(201).send(created)
  })
  app.get('/api/workflow-runs/:id', async (request) =>
    orchestrator.workflowSnapshot(IdParams.parse(request.params).id),
  )
  app.get('/api/workflow-runs/:id/events', async (request) =>
    orchestrator.workflowEvents(IdParams.parse(request.params).id),
  )
  app.post('/api/workflow-runs/:id/stop', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    // Stop never waits on a stale page: the body is validated but its revision is not compared.
    RunControlSchema.parse(request.body)
    return orchestrator.wfStop(id)
  })
  app.post('/api/workflow-runs/:id/pause', mutation, async (request) =>
    orchestrator.wfPause(IdParams.parse(request.params).id, RunControlSchema.parse(request.body)),
  )
  app.post('/api/workflow-runs/:id/resume', mutation, async (request) =>
    orchestrator.wfResume(IdParams.parse(request.params).id, RunControlSchema.parse(request.body)),
  )
  app.post('/api/workflow-runs/:id/limits', mutation, async (request) =>
    orchestrator.wfLimits(
      IdParams.parse(request.params).id,
      LimitsDecisionSchema.parse(request.body),
    ),
  )
  app.post('/api/workflow-runs/:id/waiver', mutation, async (request) =>
    orchestrator.wfWaiver(
      IdParams.parse(request.params).id,
      WaiverDecisionSchema.parse(request.body),
    ),
  )
  app.post('/api/workflow-runs/:id/abandon', mutation, async (request) =>
    orchestrator.wfAbandon(
      IdParams.parse(request.params).id,
      AbandonDecisionSchema.parse(request.body),
    ),
  )
  app.post('/api/workflow-runs/:id/remap', mutation, async (request) =>
    orchestrator.wfRemap(
      IdParams.parse(request.params).id,
      WorkflowRemapDecisionSchema.parse(request.body),
    ),
  )
  app.post('/api/workflow-runs/:id/gates/:gateId/decision', mutation, async (request) => {
    const { id, gateId } = GateParams.parse(request.params)
    return orchestrator.wfGateDecision(id, gateId, GateDecisionSchema.parse(request.body))
  })
  app.post('/api/workflow-runs/:id/nodes/:nodeId/retry', mutation, async (request) => {
    const { id, nodeId } = NodeParams.parse(request.params)
    return orchestrator.wfRetry(id, nodeId, WorkflowRetryDecisionSchema.parse(request.body))
  })
  app.post('/api/workflow-runs/:id/nodes/:nodeId/policy-remap', mutation, async (request) => {
    const { id, nodeId } = NodeParams.parse(request.params)
    return orchestrator.wfPolicyRemap(
      id,
      nodeId,
      WorkflowPolicyRemapDecisionSchema.parse(request.body),
    )
  })
  app.post('/api/workflow-runs/:id/nodes/:nodeId/quota', mutation, async (request) => {
    const { id, nodeId } = NodeParams.parse(request.params)
    return orchestrator.wfQuotaDecision(id, nodeId, QuotaDecisionSchema.parse(request.body))
  })
  app.post('/api/workflow-runs/:id/nodes/:nodeId/try-again', mutation, async (request) => {
    const { id, nodeId } = NodeParams.parse(request.params)
    return orchestrator.wfTryAgain(id, nodeId, WorkflowTryAgainDecisionSchema.parse(request.body))
  })
}

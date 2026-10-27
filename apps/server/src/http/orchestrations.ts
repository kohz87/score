import {
  AbandonDecisionSchema,
  FenceLiftSchema,
  GateDecisionSchema,
  InquiryAnswerSchema,
  LimitsDecisionSchema,
  OrchestrationCreateSchema,
  PolicyRemapDecisionSchema,
  QuotaDecisionSchema,
  RunControlSchema,
  RemapDecisionSchema,
  WaiverDecisionSchema,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import { requestIdempotency } from './idempotency.ts'
import { HttpError } from '../errors.ts'
import { FRESH_AUTH_MS } from '../terminal/tickets.ts'
import { checkRoot, type RootPolicy } from '../workspace/policy.ts'
import { splitCommand } from '../domain/orchestration/check-command.ts'

const IdParams = z.object({ id: z.string().min(1).max(100) })
const GateParams = IdParams.extend({ gateId: z.string().min(1).max(100) })
const StepParams = IdParams.extend({ stepId: z.string().min(1).max(100) })
const InquiryParams = IdParams.extend({ inquiryId: z.string().min(1).max(100) })
const PreflightQuery = z.object({
  leadAgentId: z.string().min(1).max(256),
  allowedAgents: z
    .string()
    .max(2000)
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
})

// Contract §14. Decisions (H) need the paired session and carry the run revision the page showed.
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  deps: {
    orchestrator: Orchestrator
    db: ScoreDb
    port: Pick<HermesPort, 'listAgents'>
    clock?: () => number
    checkPolicy?: RootPolicy
    hostEnrolled?: () => boolean
  },
): void {
  const { orchestrator } = deps
  const receipts = requestIdempotency(deps.db, deps.clock ?? Date.now)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  app.get('/api/orchestrations/preflight', async (request) => {
    const query = PreflightQuery.parse(request.query)
    return orchestrator.preflight(
      query.leadAgentId,
      query.allowedAgents,
      await deps.port.listAgents(),
    )
  })
  app.get('/api/orchestrations/fence', async () => orchestrator.fence())
  app.post('/api/orchestrations/fence/lift', mutation, async (request) => {
    const body = FenceLiftSchema.parse(request.body)
    return orchestrator.liftFence(body.expectedRevision, body.note)
  })

  app.get('/api/orchestrations', async () => orchestrator.list())
  app.post('/api/orchestrations', mutation, async (request, reply) => {
    const body = OrchestrationCreateSchema.parse(request.body)
    if (body.check) {
      // 3.13: the oracle runs a command as this user. Same bar as opening a terminal: the host set the security
      // password, and this session proved it (or a passkey) in the last minute. Checked before anything is created.
      if (!deps.checkPolicy || !deps.hostEnrolled?.())
        throw new HttpError(
          403,
          'second_factor_not_enrolled',
          'Set the security password on the Score machine with scripts/score password first.',
        )
      const split = splitCommand(body.check.command)
      if (!split.ok) throw new HttpError(400, 'invalid_check', split.reason)
      const root = await checkRoot(body.check.workspace, deps.checkPolicy)
      if (!root.ok) throw new HttpError(400, 'invalid_check', root.reason)
      const session = app.pairing.pairedSession(request.headers.cookie)
      if (session === undefined || !app.pairing.takeFresh(session, FRESH_AUTH_MS))
        throw new HttpError(
          403,
          'fresh_auth_required',
          'Confirm your security password or passkey first.',
        )
      body.check = { ...body.check, workspace: root.real }
    }
    const created = await orchestrator.create(body, await deps.port.listAgents())
    return reply.code(201).send(created)
  })
  app.get('/api/orchestrations/:id', async (request) =>
    orchestrator.snapshot(IdParams.parse(request.params).id),
  )

  app.get('/api/orchestrations/:id/events', async (request) =>
    orchestrator.events(IdParams.parse(request.params).id),
  )

  app.post('/api/orchestrations/:id/stop', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    // Stop never waits on a stale page: the body is validated but its revision is not compared.
    RunControlSchema.parse(request.body)
    return orchestrator.stop(id)
  })
  app.post('/api/orchestrations/:id/check/run', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.runCheck(id, RunControlSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/check/waive', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.waiveCheck(id, RunControlSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/pause', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.pause(id, RunControlSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/resume', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.resume(id, RunControlSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/gates/:gateId/decision', mutation, async (request) => {
    const { id, gateId } = GateParams.parse(request.params)
    return orchestrator.gateDecision(id, gateId, GateDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/inquiries/:inquiryId/answer', mutation, async (request) => {
    const { id, inquiryId } = InquiryParams.parse(request.params)
    return orchestrator.inquiryAnswer(id, inquiryId, InquiryAnswerSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/limits', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.limits(id, LimitsDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/waiver', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.waiver(id, WaiverDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/remap', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.remap(id, RemapDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/steps/:stepId/remap', mutation, async (request) => {
    const { id, stepId } = StepParams.parse(request.params)
    return orchestrator.policyRemap(id, stepId, PolicyRemapDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/steps/:stepId/quota', mutation, async (request) => {
    const { id, stepId } = StepParams.parse(request.params)
    return orchestrator.quotaDecision(id, stepId, QuotaDecisionSchema.parse(request.body))
  })
  app.post('/api/orchestrations/:id/abandon', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    return orchestrator.abandon(id, AbandonDecisionSchema.parse(request.body))
  })
}

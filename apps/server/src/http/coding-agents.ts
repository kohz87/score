import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CodingAgentCreateSchema,
  CODING_EFFORTS,
  CodingAgentPatchSchema,
  CodingAgentSchema,
  AgentSummarySchema,
  CodingAgentsResponseSchema,
  CodingBackendSchema,
  CodingModelsResponseSchema,
  CodingRuntimeSchema,
  CodingRuntimesResponseSchema,
  CodingQuotaResponseSchema,
  CodingUsageSchema,
  CodingVersionConfirmSchema,
  type CodingPermission,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { SecurityPassword } from '../auth/security-password.ts'
import type { ScoreDb } from '../db/index.ts'
import { readAgent, reconcileAgents } from '../domain/agents.ts'
import { syncTeamRoomMembers } from '../domain/team-room.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { driverFor } from '../runtimes/coding/drivers.ts'
import { instructionsEtag } from '../runtimes/coding/instructions.ts'
import type { CodingRuntime } from '../runtimes/coding/service.ts'
import {
  getCodingAgent,
  insertCodingAgent,
  removeCodingAgent,
  updateCodingAgent,
} from '../runtimes/coding/store.ts'
import { expandHome, checkRoot } from '../workspace/policy.ts'
import { sessionKey } from './session.ts'

const Params = z.object({ agentId: z.string().min(1).max(64) })

/**
 * Coding agents (PLAN 7.2): Team › Add agent › Coding agent. Reads are open to the paired browser; every change is
 * a human decision, and `full` access also needs the security password.
 */
export function registerCodingAgentRoutes(
  app: FastifyInstance,
  deps: {
    coding: CodingRuntime
    port: HermesPort
    db: ScoreDb
    ingest: Ingest
    security: SecurityPassword | undefined
    /** Where default workspaces are made (`~/score-workspaces`). */
    workspaceBase?: string
    clock?: () => number
  },
): void {
  const { coding, port, db, ingest, security } = deps
  const clock = deps.clock ?? Date.now
  const base = deps.workspaceBase ?? join(homedir(), 'score-workspaces')
  const guard = { preHandler: [humanGuard(app.pairing)] }

  async function requirePassword(
    request: { headers: { cookie?: string | undefined } },
    password: string | undefined,
  ): Promise<void> {
    if (!security) throw new HttpError(501, 'unsupported', 'Full access isn’t available here.')
    await security.verify(password, sessionKey(request.headers.cookie))
  }

  async function publish(agentId: string): Promise<void> {
    const details = (await coding.details()).filter((detail) => detail.id === agentId)
    if (details.length) await reconcileAgents(ingest, details)
  }

  async function workspaceFor(id: string, requested: string | undefined): Promise<string> {
    const wanted = requested ? expandHome(requested.trim(), homedir()) : join(base, id)
    if (!requested) mkdirSync(wanted, { recursive: true })
    const checked = await checkRoot(wanted, coding.policy)
    if (!checked.ok) throw new HttpError(422, 'workspace_unavailable', checked.reason)
    return checked.real
  }

  function assertVerified(
    driver: ReturnType<typeof driverFor>,
    permission: CodingPermission,
  ): void {
    if (!coding.locator.verifiedPermissions(driver).includes(permission))
      throw new HttpError(
        422,
        'permission_unverified',
        `${driver.label} is not verified for ${permission} access yet.`,
      )
  }

  app.get('/api/coding-agents', async () =>
    CodingAgentsResponseSchema.parse({
      items: await Promise.all(coding.agents().map((agent) => coding.view(agent))),
    }),
  )
  app.get('/api/coding-agents/backend', async () => CodingBackendSchema.parse(coding.backend()))
  app.post('/api/coding-agents/backend/check', guard, async () =>
    CodingBackendSchema.parse(await coding.checkBackend()),
  )
  app.get('/api/coding-agents/runtimes', async () =>
    CodingRuntimesResponseSchema.parse({ items: await coding.locator.info() }),
  )

  app.get('/api/coding-agents/runtimes/:runtime/usage', async (request) => {
    const { runtime } = z.object({ runtime: CodingRuntimeSchema }).parse(request.params)
    return CodingUsageSchema.parse(await coding.usage(runtime))
  })

  app.get('/api/coding-agents/runtimes/:runtime/models', async (request) => {
    const { runtime } = z.object({ runtime: CodingRuntimeSchema }).parse(request.params)
    const { fresh } = z.object({ fresh: z.enum(['1']).optional() }).parse(request.query)
    return CodingModelsResponseSchema.parse(await coding.models(runtime, fresh === '1'))
  })

  app.get('/api/coding-agents/runtimes/:runtime/quota', async (request) => {
    const { runtime } = z.object({ runtime: CodingRuntimeSchema }).parse(request.params)
    return CodingQuotaResponseSchema.parse({ quota: await coding.quotaOfRuntime(runtime) })
  })
  app.get('/api/coding-agents/:id/quota', async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params)
    const agent = getCodingAgent(db.sqlite, id)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    return CodingQuotaResponseSchema.parse({ quota: await coding.quotaOf(agent) })
  })

  app.post('/api/coding-agents', guard, async (request, reply) => {
    const body = CodingAgentCreateSchema.parse(request.body)
    const driver = driverFor(body.runtime)
    const taken =
      getCodingAgent(db.sqlite, body.id, true) !== null ||
      (await port.listAgents()).some((agent) => agent.id === body.id)
    if (taken || body.id === 'default')
      throw new HttpError(409, 'conflict', 'An agent with this ID already exists.')
    const cli = await coding.locator.detect(driver)
    if (cli.state === 'not_supported' || cli.state === 'not_installed')
      throw new HttpError(422, 'cli_not_installed', cli.message ?? 'The CLI isn’t available.')
    if (driver.requiresReadAck(body.permission) && body.acknowledgeReads !== true)
      throw new HttpError(
        400,
        'acknowledgement_required',
        `A ${driver.label} agent can read every file your user can including secrets outside its workspace. Confirm that to add it.`,
      )
    assertVerified(driver, body.permission)
    if (body.permission === 'full') await requirePassword(request, body.password)
    const workspace = await workspaceFor(body.id, body.workspace)
    const createdAt = new Date(clock()).toISOString()
    db.tx((sqlite) =>
      insertCodingAgent(sqlite, {
        id: body.id,
        name: body.name,
        role: body.role,
        instructions: body.instructions,
        runtime: body.runtime,
        workspace,
        permission: body.permission,
        model: body.model ?? null,
        style: body.style,
        ...(body.quotaFloorPercent !== undefined
          ? { quotaFloorPercent: body.quotaFloorPercent }
          : {}),
        createdAt,
      }),
    )
    await publish(body.id)
    const created = getCodingAgent(db.sqlite, body.id)!
    return reply.code(201).send(CodingAgentSchema.parse(await coding.view(created)))
  })

  app.patch('/api/coding-agents/:agentId', guard, async (request) => {
    const { agentId } = Params.parse(request.params)
    const body = CodingAgentPatchSchema.parse(request.body)
    const agent = getCodingAgent(db.sqlite, agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    if (body.effort) {
      const allowed = CODING_EFFORTS[agent.runtime]
      if (!allowed) throw new HttpError(400, 'bad_request', 'This runtime has no effort setting.')
      if (!allowed.includes(body.effort))
        throw new HttpError(400, 'bad_request', `Effort must be one of: ${allowed.join(', ')}.`)
    }
    if (body.permission && body.permission !== agent.permission)
      assertVerified(driverFor(agent.runtime), body.permission)
    // Raising the access level is the sensitive change; lowering it never needs the password. The password is
    // verified here, outside the transaction (it's slow); the transition that is committed is judged again inside it.
    const order: CodingPermission[] = ['read-only', 'workspace-write', 'full']
    const raising =
      body.permission === 'full' && order.indexOf(body.permission) > order.indexOf(agent.permission)
    if (raising) await requirePassword(request, body.password)
    const workspace = body.workspace ? await workspaceFor(agentId, body.workspace) : undefined
    db.tx((sqlite) => {
      // The agent may have changed while we awaited; never write a permission decided from a stale read.
      const current = getCodingAgent(sqlite, agentId)
      if (!current) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
      if (body.permission === 'full' && current.permission !== 'full' && !raising)
        throw new HttpError(
          409,
          'conflict',
          'This agent changed while you were editing it. Reload and confirm with your password to give it full access.',
        )
      // The instructions text is an etag-checked edit (like SOUL.md): a stale base changes nothing in this request.
      if (
        body.instructions !== undefined &&
        body.instructionsEtag !== instructionsEtag(current.instructions)
      )
        throw new HttpError(
          409,
          'conflict',
          'These instructions were changed somewhere else. Reload to see the newest version.',
          { etag: instructionsEtag(current.instructions), instructions: current.instructions },
        )
      updateCodingAgent(sqlite, agentId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.instructions !== undefined ? { instructions: body.instructions } : {}),
        ...(body.permission !== undefined ? { permission: body.permission } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        ...(body.quotaFloorPercent !== undefined
          ? { quotaFloorPercent: body.quotaFloorPercent }
          : {}),
      })
    })
    await publish(agentId)
    return CodingAgentSchema.parse(await coding.view(getCodingAgent(db.sqlite, agentId)!))
  })

  app.post('/api/coding-agents/:agentId/confirm-version', guard, async (request) => {
    const { agentId } = Params.parse(request.params)
    const body = CodingVersionConfirmSchema.parse(request.body)
    const agent = getCodingAgent(db.sqlite, agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    coding.locator.invalidate()
    const cli = await coding.locator.detect(driverFor(agent.runtime))
    // Only the version Score sees right now can be confirmed: a stale page can't bless a CLI that has since changed.
    if (cli.version === null || cli.version !== body.version)
      throw new HttpError(409, 'conflict', 'The installed version isn’t the one you confirmed.')
    db.tx((sqlite) => updateCodingAgent(sqlite, agentId, { confirmedVersion: body.version }))
    await publish(agentId)
    return CodingAgentSchema.parse(await coding.view(getCodingAgent(db.sqlite, agentId)!))
  })

  // The deliberate way out of a held group Score can't attribute (fix batch X). Never signals anything.
  app.post('/api/coding-agents/:agentId/release', guard, async (request) => {
    const { agentId } = Params.parse(request.params)
    z.object({})
      .strict()
      .parse(request.body ?? {})
    if (!getCodingAgent(db.sqlite, agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    // The paired browser is named by the hash of its session, never the secret.
    coding.release(agentId, sessionKey(request.headers.cookie).slice(0, 16))
    await publish(agentId)
    return CodingAgentSchema.parse(await coding.view(getCodingAgent(db.sqlite, agentId)!))
  })

  app.delete('/api/coding-agents/:agentId', guard, async (request, reply) => {
    const { agentId } = Params.parse(request.params)
    if (!getCodingAgent(db.sqlite, agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that coding agent.')
    // Not while any of its runs is unresolved: running or queued, not proven ended, a launch that isn't settled, or a
    // held group. Its launches keep their routing until then (7.7b §2).
    if (coding.hasUnresolvedRuns(agentId))
      throw new HttpError(
        409,
        'agent_busy',
        'This agent still has work Score can’t call finished. Stop it and wait until it has ended first.',
      )
    db.tx((sqlite) => removeCodingAgent(sqlite, agentId, new Date(clock()).toISOString()))
    // Gone from Team and Reports (their lists read the projection); browsers hear it as a removed agent.
    await ingest.submit({
      source: `coding:${agentId}`,
      identity: `removed:${agentId}:${randomUUID()}`,
      apply({ sqlite, now }) {
        const previous = readAgent(sqlite, agentId)
        sqlite.prepare('DELETE FROM agents_proj WHERE id = ?').run(agentId)
        return previous
          ? [
              {
                type: 'agent.updated' as const,
                data: AgentSummarySchema.parse({
                  ...previous,
                  served: false,
                  status: 'offline',
                  lifecycle: { state: 'removed', incarnationId: randomUUID(), operationId: null },
                }),
              },
              ...syncTeamRoomMembers(sqlite, now, [agentId]),
            ]
          : []
      },
    })
    return reply.code(204).send()
  })
}

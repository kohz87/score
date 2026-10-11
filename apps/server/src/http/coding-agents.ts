import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CodingAgentCreateSchema,
  CodingAgentPatchSchema,
  CodingAgentSchema,
  AgentSummarySchema,
  CodingAgentsResponseSchema,
  CodingRuntimeSchema,
  CodingRuntimesResponseSchema,
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
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { driverFor } from '../runtimes/coding/drivers.ts'
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
    if (!security) throw new HttpError(501, 'unsupported', 'Full access is not available here')
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

  function assertVerified(driver: ReturnType<typeof driverFor>, permission: CodingPermission): void {
    if (!coding.locator.verifiedPermissions(driver).includes(permission))
      throw new HttpError(
        422,
        'permission_unverified',
        `${driver.label} is not verified for ${permission} access yet`,
      )
  }

  app.get('/api/coding-agents', async () =>
    CodingAgentsResponseSchema.parse({
      items: await Promise.all(coding.agents().map((agent) => coding.view(agent))),
    }),
  )
  app.get('/api/coding-agents/runtimes', async () =>
    CodingRuntimesResponseSchema.parse({ items: await coding.locator.info() }),
  )

  app.get('/api/coding-agents/runtimes/:runtime/usage', async (request) => {
    const { runtime } = z.object({ runtime: CodingRuntimeSchema }).parse(request.params)
    return CodingUsageSchema.parse(await coding.usage(runtime))
  })

  app.post('/api/coding-agents', guard, async (request, reply) => {
    const body = CodingAgentCreateSchema.parse(request.body)
    const driver = driverFor(body.runtime)
    const taken =
      getCodingAgent(db.sqlite, body.id, true) !== null ||
      (await port.listAgents()).some((agent) => agent.id === body.id)
    if (taken || body.id === 'default')
      throw new HttpError(409, 'conflict', 'An agent with this id already exists')
    const cli = await coding.locator.detect(driver)
    if (cli.state === 'not_supported' || cli.state === 'not_installed')
      throw new HttpError(422, 'cli_not_installed', cli.message ?? 'The CLI is not available')
    if (driver.requiresReadAck && body.acknowledgeReads !== true)
      throw new HttpError(
        400,
        'acknowledgement_required',
        `A ${driver.label} agent can read every file your user can (secrets outside its workspace too); confirm that to add it`,
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
        runtime: body.runtime,
        workspace,
        permission: body.permission,
        model: body.model ?? null,
        style: body.style,
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
    if (!agent) throw new HttpError(404, 'not_found', 'Unknown coding agent')
    if (body.permission && body.permission !== agent.permission)
      assertVerified(driverFor(agent.runtime), body.permission)
    // Raising the access level is the sensitive change; lowering it never needs the password.
    const order: CodingPermission[] = ['read-only', 'workspace-write', 'full']
    if (
      body.permission &&
      body.permission === 'full' &&
      order.indexOf(body.permission) > order.indexOf(agent.permission)
    )
      await requirePassword(request, body.password)
    const workspace = body.workspace ? await workspaceFor(agentId, body.workspace) : undefined
    db.tx((sqlite) =>
      updateCodingAgent(sqlite, agentId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.permission !== undefined ? { permission: body.permission } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
      }),
    )
    await publish(agentId)
    return CodingAgentSchema.parse(await coding.view(getCodingAgent(db.sqlite, agentId)!))
  })

  app.post('/api/coding-agents/:agentId/confirm-version', guard, async (request) => {
    const { agentId } = Params.parse(request.params)
    const body = CodingVersionConfirmSchema.parse(request.body)
    const agent = getCodingAgent(db.sqlite, agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Unknown coding agent')
    coding.locator.invalidate()
    const cli = await coding.locator.detect(driverFor(agent.runtime))
    // Only the version Score sees right now can be confirmed: a stale page can't bless a CLI that has since changed.
    if (cli.version === null || cli.version !== body.version)
      throw new HttpError(409, 'conflict', 'The installed version is not the one you confirmed')
    db.tx((sqlite) => updateCodingAgent(sqlite, agentId, { confirmedVersion: body.version }))
    await publish(agentId)
    return CodingAgentSchema.parse(await coding.view(getCodingAgent(db.sqlite, agentId)!))
  })

  app.delete('/api/coding-agents/:agentId', guard, async (request, reply) => {
    const { agentId } = Params.parse(request.params)
    if (!getCodingAgent(db.sqlite, agentId))
      throw new HttpError(404, 'not_found', 'Unknown coding agent')
    const busy = db.sqlite
      .prepare(
        "SELECT 1 FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') LIMIT 1",
      )
      .get(agentId)
    if (busy) throw new HttpError(409, 'conflict', 'Stop this agent’s running turn first')
    db.tx((sqlite) => removeCodingAgent(sqlite, agentId, new Date(clock()).toISOString()))
    // Gone from Team and Reports (their lists read the projection); browsers hear it as a removed agent.
    await ingest.submit({
      source: `coding:${agentId}`,
      identity: `removed:${agentId}:${randomUUID()}`,
      apply({ sqlite }) {
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
            ]
          : []
      },
    })
    return reply.code(204).send()
  })
}

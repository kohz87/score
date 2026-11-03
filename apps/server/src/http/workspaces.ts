import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  AgentSummarySchema,
  RoomWorkspaceRequestSchema,
  SharedWorkspaceCreateRequestSchema,
  SharedWorkspaceListSchema,
  SharedWorkspaceSchema,
  SharedWorkspaceUpdateRequestSchema,
  UseAsFolderRequestSchema,
  type Room,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { Config } from '../config.ts'
import type { ScoreDb } from '../db/index.ts'
import { getSharedWorkspace, listSharedWorkspaces } from '../domain/workspaces.ts'
import { readRoom, roomChanged, roomRow } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import { resolveHermesHome, type HermesPort } from '../hermes/index.ts'
import type { DomainEventDraft, Ingest } from '../hub/ingest.ts'
import { isCodingAgent } from '../runtimes/coding/store.ts'
import { checkRoot, defaultRootPolicy, expandHome, type RootPolicy } from '../workspace/policy.ts'
import { requestIdempotency } from './idempotency.ts'

const IdParams = z.object({ id: z.string().min(1).max(200) })
const RoomParams = z.object({ roomId: z.string().min(1).max(200) })

const notFound = () => new HttpError(404, 'not_found', 'Couldn’t find that workspace.')

// Shared workspaces (contract § Workspaces, 3.20.0). A folder is only ever added after `checkRoot` accepted it, with the
// same policy the agents' own folders pass; the coding runtime checks it again whenever it is used.
export function registerWorkspacesRoutes(
  app: FastifyInstance,
  options: {
    port: HermesPort
    db: ScoreDb
    ingest: Ingest
    config: Pick<Config, 'home' | 'hermesHome'>
    policy?: RootPolicy
    clock?: () => number
  },
): void {
  const { port, db, ingest } = options
  const { home, hermesHome } = options.config
  const policy =
    options.policy ?? defaultRootPolicy([home, resolveHermesHome(hermesHome), resolveHermesHome()])
  const receipts = requestIdempotency(db, options.clock)
  const guard = { preHandler: [humanGuard(app.pairing)] }
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  async function assertAgentsExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const known = new Set(
      z
        .array(AgentSummarySchema)
        .parse(await port.listAgents())
        .map((agent) => agent.id),
    )
    if (ids.some((id) => !known.has(id)))
      throw new HttpError(400, 'bad_request', 'Couldn’t find that agent.')
  }

  /** The folder to store: it must pass the root policy; `create` makes a missing one (0700) under a parent that passes. */
  async function acceptFolder(input: string, create: boolean): Promise<string> {
    let checked = await checkRoot(input, policy)
    if (!checked.ok && create) {
      const target = expandHome(input.trim(), policy.home)
      const missing = await lstat(target).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      )
      if (missing && target.startsWith('/')) {
        const parent = await checkRoot(dirname(target), policy)
        if (!parent.ok)
          throw new HttpError(422, 'workspace_unavailable', `The parent folder: ${parent.reason}`)
        // Not recursive: only the one folder the person named, directly under a folder that passed.
        await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          throw new HttpError(
            422,
            'workspace_unavailable',
            error.code === 'EEXIST'
              ? 'That folder already exists.'
              : 'Couldn’t create that folder.',
          )
        })
        checked = await checkRoot(target, policy)
        // The new folder did not pass (e.g. it is a forbidden one): take back what was just made.
        if (!checked.ok) await rmdir(target).catch(() => undefined)
      }
    }
    if (!checked.ok) throw new HttpError(422, 'workspace_unavailable', checked.reason)
    return checked.real
  }

  app.get('/api/workspaces', guard, async () =>
    SharedWorkspaceListSchema.parse({
      workspaces: db.read((sqlite) => listSharedWorkspaces(sqlite)),
    }),
  )

  app.post('/api/workspaces', mutation, async (request, reply) => {
    const body = SharedWorkspaceCreateRequestSchema.parse(request.body)
    const real = await acceptFolder(body.path, body.create === true)
    const id = randomUUID()
    await ingest.submit({
      source: 'workspaces',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        if (sqlite.prepare('SELECT 1 FROM workspaces WHERE name = ?').get(body.name))
          throw new HttpError(409, 'conflict', 'A workspace with that name already exists.')
        if (sqlite.prepare('SELECT 1 FROM workspaces WHERE path = ?').get(real))
          throw new HttpError(409, 'conflict', 'That folder is already a workspace.')
        sqlite
          .prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
          .run(id, body.name, real, now)
        return []
      },
    })
    return reply
      .code(201)
      .send(SharedWorkspaceSchema.parse(db.read((s) => getSharedWorkspace(s, id))))
  })

  app.patch('/api/workspaces/:id', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    const body = SharedWorkspaceUpdateRequestSchema.parse(request.body)
    const agentIds = body.agentIds === undefined ? undefined : [...new Set(body.agentIds)]
    if (agentIds) await assertAgentsExist(agentIds)
    await ingest.submit({
      source: 'workspaces',
      identity: randomUUID(),
      apply({ sqlite }) {
        if (!sqlite.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) throw notFound()
        if (body.name !== undefined) {
          if (
            sqlite.prepare('SELECT 1 FROM workspaces WHERE name = ? AND id != ?').get(body.name, id)
          )
            throw new HttpError(409, 'conflict', 'A workspace with that name already exists.')
          sqlite.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(body.name, id)
        }
        if (agentIds) {
          sqlite.prepare('DELETE FROM workspace_agents WHERE workspace_id = ?').run(id)
          const add = sqlite.prepare(
            'INSERT INTO workspace_agents (workspace_id, agent_id) VALUES (?, ?)',
          )
          for (const agentId of agentIds) add.run(id, agentId)
        }
        return []
      },
    })
    return SharedWorkspaceSchema.parse(db.read((s) => getSharedWorkspace(s, id)))
  })

  // Rooms that used it go back to none; the folder itself is never touched.
  app.delete('/api/workspaces/:id', mutation, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    await ingest.submit({
      source: 'workspaces',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        if (!sqlite.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) throw notFound()
        const rooms = sqlite
          .prepare('SELECT id FROM rooms WHERE workspace_id = ?')
          .all(id)
          .map((row) => z.object({ id: z.string() }).parse(row).id)
        const before = new Map(rooms.map((roomId) => [roomId, readRoom(sqlite, roomId, now)]))
        sqlite.prepare('UPDATE rooms SET workspace_id = NULL WHERE workspace_id = ?').run(id)
        sqlite.prepare('DELETE FROM workspace_agents WHERE workspace_id = ?').run(id)
        sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
        const events: DomainEventDraft[] = []
        for (const roomId of rooms)
          events.push(...roomChanged(sqlite, roomId, now, before.get(roomId)))
        return events
      },
    })
    return reply.code(204).send()
  })

  app.put('/api/rooms/:roomId/workspace', mutation, async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const { workspaceId } = RoomWorkspaceRequestSchema.parse(request.body)
    let room: Room | undefined
    await ingest.submit({
      source: 'workspaces',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const row = roomRow(sqlite, roomId)
        if (
          workspaceId !== null &&
          !sqlite.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId)
        )
          throw notFound()
        const before = readRoom(sqlite, roomId, row.updated_at)
        sqlite.prepare('UPDATE rooms SET workspace_id = ? WHERE id = ?').run(workspaceId, roomId)
        room = readRoom(sqlite, roomId, now)
        return roomChanged(sqlite, roomId, now, before)
      },
    })
    return room
  })

  // A Hermes agent has one folder (its profile's terminal.cwd), so "use this workspace" sets that. Only for an agent that
  // is assigned, only for a Hermes agent (a coding agent follows the room instead), only where the folder is on this machine.
  app.post('/api/workspaces/:id/use-as-folder', mutation, async (request) => {
    const { id } = IdParams.parse(request.params)
    const { agentId } = UseAsFolderRequestSchema.parse(request.body)
    const workspace = db.read((sqlite) => getSharedWorkspace(sqlite, id))
    if (!workspace) throw notFound()
    if (!workspace.agentIds.includes(agentId))
      throw new HttpError(409, 'not_assigned', 'Assign this agent to the workspace first.')
    if (db.read((sqlite) => isCodingAgent(sqlite, agentId)))
      throw new HttpError(
        409,
        'unsupported',
        'A coding agent works in the chat’s workspace; only Hermes agents have a single folder.',
      )
    await assertAgentsExist([agentId])
    const current = await port.readWorkspaceConfig(agentId)
    if (current.backend !== null && current.backend.trim().toLowerCase() !== 'local')
      throw new HttpError(422, 'workspace_unavailable', 'This agent works on a remote terminal.')
    const checked = await checkRoot(workspace.path, policy)
    if (!checked.ok) throw new HttpError(422, 'workspace_unavailable', checked.reason)
    await port.setWorkspaceCwd(agentId, checked.real)
    request.log.info(
      { agentId, workspace: { op: 'use-as-folder', path: checked.real } },
      'workspace root',
    )
    return { root: checked.real }
  })
}

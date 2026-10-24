import { randomUUID } from 'node:crypto'
import {
  MessageSearchResponseSchema,
  RoomProjectBodySchema,
  RoomProjectSchema,
  type RoomProject,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { buildRoomExport, roomExportMarkdown } from '../domain/room-export.ts'
import { createProject, deleteProject, updateProject } from '../domain/room-projects.ts'
import { searchMessages } from '../domain/room-search.ts'
import { roomRow } from '../domain/rooms.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const SearchQuerySchema = z
  .object({
    q: z.string().max(500).default(''),
    roomId: z.string().min(1).max(256).optional(),
    jobId: z.string().min(1).max(64).optional(),
    /** `default`: only rooms' default jobs (what the classic shell can open). */
    jobs: z.literal('default').optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
const IdParams = z.object({ id: z.string().min(1).max(200) })
const RoomParams = z.object({ roomId: z.string().min(1).max(256) })

// Chat conversations beyond the thread itself (PLAN 5.26): projects, message search, export.
export function registerConversationRoutes(
  app: FastifyInstance,
  deps: { db: ScoreDb; ingest: Ingest; port: HermesPort; clock?: () => number },
): void {
  const { db, ingest, port } = deps
  const clock = deps.clock ?? Date.now
  const guard = { preHandler: [humanGuard(app.pairing)] }

  app.post('/api/room-projects', guard, async (request) => {
    const body = RoomProjectBodySchema.parse(request.body)
    const project: RoomProject = { id: randomUUID(), name: body.name, color: body.color }
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => createProject(sqlite, project, now),
    })
    return RoomProjectSchema.parse(project)
  })
  app.patch('/api/room-projects/:id', guard, async (request) => {
    const { id } = IdParams.parse(request.params)
    const body = RoomProjectBodySchema.partial()
      .refine((value) => Object.keys(value).length > 0)
      .parse(request.body)
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite }) => updateProject(sqlite, id, body),
    })
    return db.read((sqlite) =>
      RoomProjectSchema.parse(
        sqlite.prepare('SELECT id, name, color FROM room_projects WHERE id = ?').get(id),
      ),
    )
  })
  app.delete('/api/room-projects/:id', guard, async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => deleteProject(sqlite, id, now),
    })
    return reply.code(204).send()
  })

  app.get('/api/search/messages', async (request) => {
    const { q, roomId, jobId, jobs, limit } = SearchQuerySchema.parse(request.query)
    return MessageSearchResponseSchema.parse({
      items: db.read((sqlite) =>
        searchMessages(sqlite, q, limit, roomId, jobId, jobs === 'default'),
      ),
    })
  })

  async function exported(roomId: string) {
    const agents = await port.listAgents().catch(() => [])
    const names = new Map(agents.map((agent) => [agent.id, agent.name]))
    return db.read((sqlite) =>
      buildRoomExport(sqlite, roomId, names, new Date(clock()).toISOString()),
    )
  }
  const fileName = (name: string, extension: string) =>
    `score-${
      name
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'room'
    }.${extension}`

  app.get('/api/rooms/:roomId/export.md', async (request, reply) => {
    const { roomId } = RoomParams.parse(request.params)
    db.read((sqlite) => roomRow(sqlite, roomId))
    const data = await exported(roomId)
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileName(data.room.name, 'md')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(roomExportMarkdown(data))
  })
  app.get('/api/rooms/:roomId/export.json', async (request, reply) => {
    const { roomId } = RoomParams.parse(request.params)
    db.read((sqlite) => roomRow(sqlite, roomId))
    const data = await exported(roomId)
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${fileName(data.room.name, 'json')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(JSON.stringify(data, null, 2))
  })
}

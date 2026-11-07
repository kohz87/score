import { randomUUID } from 'node:crypto'
import {
  RoomDeleteRequestSchema,
  TeamRoomCreateRequestSchema,
  TeamRoomsResponseSchema,
  type Room,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import { deleteRoom, roomDeletePlan } from '../../domain/room-delete.ts'
import { roomFilesInPlay, roomLearned } from '../../domain/room-panels.ts'
import { assertProject, listProjects } from '../../domain/room-projects.ts'
import {
  freeRoomName,
  insertRoom,
  readAllRooms,
  readRoom,
  refreshRooms,
  roomChanged,
  roomRow,
} from '../../domain/rooms.ts'
import { HttpError } from '../../errors.ts'
import { snapshot } from '../../hub/snapshot.ts'
import type { RoomRouteDeps } from './context.ts'
import {
  CreateSchema,
  NameSchema,
  ParamsSchema,
  PatchSchema,
  TeamNameSchema,
} from './route-schemas.ts'

export function registerRoomCatalogueRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest, clock, mutation, agents, validateAgents, refresh, isTeamRoom } = deps

  app.get('/api/rooms', async () => {
    const listed = await agents()
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const events = []
        for (const agent of listed) {
          const direct = sqlite
            .prepare("SELECT id FROM rooms WHERE kind = 'direct' AND lead_agent_id = ?")
            .get(agent.id)
          if (direct) continue
          const id = randomUUID()
          insertRoom(
            sqlite,
            {
              id,
              name: freeRoomName(sqlite, agent.name),
              kind: 'direct',
              leadAgentId: agent.id,
              members: [agent.id],
            },
            now,
          )
          events.push(...roomChanged(sqlite, id, now))
        }
        return [...events, ...refreshRooms(sqlite, now)]
      },
    })
    const result = snapshot(db, (sqlite) => {
      const all = readAllRooms(sqlite, new Date(clock()).toISOString())
      const known = new Set(listed.map((agent) => agent.id))
      return {
        projects: listProjects(sqlite),
        rooms: all.filter((room) => room.kind === 'room'),
        directs: all.filter(
          (room) =>
            room.kind === 'direct' && room.leadAgentId !== null && known.has(room.leadAgentId),
        ),
      }
    })
    return { asOfSeq: result.asOfSeq, ...result.data }
  })

  // 3.4.0 (decision 136): team rooms. The everyone room first, then the person's teams by name.
  app.get('/api/team-rooms', async () => {
    const result = snapshot(db, (sqlite) => {
      const now = new Date(clock()).toISOString()
      return sqlite
        .prepare(
          "SELECT id FROM rooms WHERE role = 'team' ORDER BY team_everyone DESC, name COLLATE NOCASE, id",
        )
        .all()
        .map((row) => readRoom(sqlite, z.object({ id: z.string() }).parse(row).id, now))
    })
    return TeamRoomsResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })
  app.post('/api/team-rooms', mutation, async (request, reply) => {
    const body = TeamRoomCreateRequestSchema.parse(request.body)
    const members = [...new Set(body.members)]
    if (!members.includes(body.leadAgentId))
      throw new HttpError(400, 'bad_request', 'The lead must be one of the team’s members.')
    // Only agents that are ready (not setting up, needing attention or leaving) join a team.
    await validateAgents(members)
    const id = randomUUID()
    let room: Room | undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        insertRoom(
          sqlite,
          {
            id,
            name: body.name,
            kind: 'room',
            leadAgentId: body.leadAgentId,
            members,
            role: 'team',
          },
          now,
        )
        room = readRoom(sqlite, id, now)
        return roomChanged(sqlite, id, now)
      },
    })
    return reply.code(201).send(room)
  })

  app.post('/api/rooms', mutation, async (request) => {
    const body = CreateSchema.parse(request.body)
    await validateAgents([...(body.members ?? []), ...(body.leadAgentId ? [body.leadAgentId] : [])])
    const id = randomUUID()
    let room: Room | undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        insertRoom(
          sqlite,
          {
            id,
            name: body.name,
            kind: 'room',
            leadAgentId: body.leadAgentId ?? null,
            members: [...new Set(body.members ?? [])],
          },
          now,
        )
        room = readRoom(sqlite, id, now)
        return roomChanged(sqlite, id, now)
      },
    })
    return room
  })

  app.patch('/api/rooms/:roomId', mutation, async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const body = PatchSchema.parse(request.body)
    // The team room always holds the whole team under its own name; only its lead and settings change (11.1b).
    if (
      isTeamRoom(roomId) &&
      (body.name !== undefined || body.archived !== undefined || body.members !== undefined)
    )
      throw new HttpError(
        409,
        'conflict',
        'The team room can’t be renamed, archived or given other members.',
      )
    // Only agents joining now must be ready: a member that is briefly not ready (setting up again, needs attention)
    // can stay while the person changes the others (3.4.0 review).
    const current = db.read((sqlite) => {
      const row = sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(roomId) as
        { members: string } | undefined
      return new Set(row ? z.array(z.string()).parse(JSON.parse(row.members)) : [])
    })
    await validateAgents(
      [...(body.members ?? []), ...(body.leadAgentId ? [body.leadAgentId] : [])].filter(
        (id) => !current.has(id),
      ),
    )
    let room: Room | undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        // Pinning, renaming, tags and the project are harmless; members, archiving and summaries are the run's.
        if (
          body.members !== undefined ||
          body.leadAgentId !== undefined ||
          body.archived !== undefined ||
          body.autoSummary !== undefined
        )
          assertRoomFree(sqlite, roomId, 'room.update')
        const row = roomRow(sqlite, roomId)
        const before = readRoom(sqlite, roomId, row.updated_at)
        if (
          row.kind === 'direct' &&
          body.leadAgentId !== undefined &&
          body.leadAgentId !== row.lead_agent_id
        )
          throw new HttpError(409, 'conflict', 'A direct room belongs to its agent.')
        if (row.role === 'team' && row.team_everyone === 0) {
          const members: string[] = body.members
            ? [...new Set(body.members)]
            : (JSON.parse(row.members) as string[])
          const lead = body.leadAgentId === undefined ? row.lead_agent_id : body.leadAgentId
          if (members.length === 0)
            throw new HttpError(400, 'bad_request', 'A team needs at least one member.')
          if (lead !== null && !members.includes(lead))
            throw new HttpError(400, 'bad_request', 'The lead must be one of the team’s members.')
        }
        const name =
          body.name === undefined
            ? row.name
            : row.role === 'team'
              ? TeamNameSchema.parse(body.name)
              : NameSchema.parse(body.name)
        if (sqlite.prepare('SELECT id FROM rooms WHERE name = ? AND id != ?').get(name, roomId))
          throw new HttpError(409, 'conflict', 'A room with that name already exists.')
        if (body.projectId) assertProject(sqlite, body.projectId)
        sqlite
          .prepare(
            `UPDATE rooms SET name = ?, lead_agent_id = ?, members = ?, pinned = ?, archived = ?, project_id = ?, tags = ?, auto_summary = ?
             WHERE id = ?`,
          )
          .run(
            name,
            body.leadAgentId ?? row.lead_agent_id,
            body.members ? JSON.stringify([...new Set(body.members)]) : row.members,
            body.pinned === undefined ? row.pinned : Number(body.pinned),
            body.archived === undefined ? row.archived : Number(body.archived),
            body.projectId === undefined ? row.project_id : body.projectId,
            body.tags === undefined
              ? row.tags
              : body.tags === null
                ? null
                : JSON.stringify([...new Set(body.tags)]),
            body.autoSummary === undefined ? row.auto_summary : JSON.stringify(body.autoSummary),
            roomId,
          )
        room = readRoom(sqlite, roomId, now)
        return roomChanged(sqlite, roomId, now, before)
      },
    })
    return room
  })

  // Delete (PLAN 5.36): Score-side only; the dialog asks for the room's name and shows `delete-plan` first.
  app.get('/api/rooms/:roomId/delete-plan', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    return db.read((sqlite) => roomDeletePlan(sqlite, roomId))
  })
  app.delete('/api/rooms/:roomId', mutation, async (request, reply) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const body = RoomDeleteRequestSchema.parse(request.body)
    if (isTeamRoom(roomId)) throw new HttpError(409, 'conflict', 'The team room can’t be deleted.')
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => deleteRoom(sqlite, roomId, body.confirm, now),
    })
    return reply.code(204).send()
  })

  app.get('/api/rooms/:roomId', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    await refresh()
    const result = snapshot(db, (sqlite) => ({
      // Busy-now is evaluated at the current time, like the rooms list (an approval may have expired since).
      room: readRoom(sqlite, roomId, new Date(clock()).toISOString()),
      filesInPlay: roomFilesInPlay(sqlite, roomId),
      learned: roomLearned(sqlite, roomId),
    }))
    return { asOfSeq: result.asOfSeq, ...result.data }
  })
}

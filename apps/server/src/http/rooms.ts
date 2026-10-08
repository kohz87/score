import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  AgentSummarySchema,
  type CommandResult,
  type Message,
  type Room,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import {
  decodeMessageCursor,
  insertRoom,
  markRoomRead,
  messagePage,
  readRoom,
  refreshRooms,
  roomChanged,
  roomIds,
  roomRow,
  storeMessage,
} from '../domain/rooms.ts'
import { roomFilesInPlay, roomLearned } from '../domain/room-panels.ts'
import { createBrief } from '../domain/briefs.ts'
import { reserveMessageRun } from '../domain/message-runs.ts'
import { PLAN_FIRST_ADDENDUM } from '../domain/plan.ts'
import { COMMANDS } from '../domain/parse.ts'
import { routeMessage, modelCommand } from '../domain/routing.ts'
import { RoutingDispatcher } from '../domain/routing-dispatch.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { requestIdempotency } from './idempotency.ts'

const NameSchema = z
  .string()
  .regex(/^#?[a-z0-9][a-z0-9-]{0,63}$/)
  .transform((name) => (name.startsWith('#') ? name : `#${name}`))
const CreateSchema = z
  .object({
    name: NameSchema,
    leadAgentId: AgentIdSchema.optional(),
    members: z.array(AgentIdSchema).optional(),
  })
  .strict()
const PatchSchema = CreateSchema.partial().refine((body) => Object.keys(body).length > 0)
const MessageBodySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(16384)
      .refine((text) => Buffer.byteLength(text, 'utf8') <= 16384),
    to: z.array(AgentIdSchema).optional(),
    planFirst: z.boolean().optional(),
    model: z.string().min(1).max(256).optional(),
    attachments: z.array(z.object({ mediaId: z.string().min(1) }).strict()).optional(),
  })
  .strict()
const ParamsSchema = z.object({ roomId: z.string().min(1).max(256) })
const QuerySchema = z
  .object({
    before: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()

export function registerRoomRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db: ScoreDb,
  ingest: Ingest,
  clock = Date.now,
): () => Promise<void> {
  // JSON escaping can expand a valid 16 KB text beyond the default receipt limit.
  const receipts = requestIdempotency(db, clock, (app.initialConfig.bodyLimit ?? 1048576) + 65536)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  const routing = new RoutingDispatcher(db, ingest, port, (error) =>
    app.log.error({ err: error }, 'Room run admission failed'),
  )
  app.addHook('preClose', async () => {
    await routing.close()
  })
  const agents = async () =>
    z
      .array(AgentSummarySchema)
      .parse(await port.listAgents())
      .filter((agent) => agentAdmits(db.sqlite, agent.id))
  async function validateAgents(ids: string[]) {
    const known = new Set((await agents()).map((agent) => agent.id))
    if (ids.some((id) => !known.has(id))) throw new HttpError(400, 'bad_request', 'Unknown agent')
  }
  const refresh = () =>
    ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => refreshRooms(sqlite, now),
    })
  // The periodic tick reads first: an idle refresh must not create an observation (gate review #13).
  const tick = async () => {
    const now = new Date(clock()).toISOString()
    const changed = db.read((sqlite) =>
      roomIds(sqlite).some(
        (id) =>
          JSON.stringify(readRoom(sqlite, id, roomRow(sqlite, id).updated_at)) !==
          JSON.stringify(readRoom(sqlite, id, now)),
      ),
    )
    if (changed) await refresh()
  }
  const timer = setInterval(() => {
    void tick().catch((error: unknown) =>
      app.log.error({ err: error }, 'Room activity refresh failed'),
    )
  }, 30000)
  timer.unref()
  app.addHook('preClose', async () => {
    clearInterval(timer)
  })

  app.get('/api/commands', async () => ({ items: COMMANDS }))

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
            { id, name: agent.name, kind: 'direct', leadAgentId: agent.id, members: [agent.id] },
            now,
          )
          events.push(...roomChanged(sqlite, id, now))
        }
        return [...events, ...refreshRooms(sqlite, now)]
      },
    })
    const result = snapshot(db, (sqlite) => {
      const all = roomIds(sqlite).map((id) => readRoom(sqlite, id, roomRow(sqlite, id).updated_at))
      const known = new Set(listed.map((agent) => agent.id))
      return {
        rooms: all.filter((room) => room.kind === 'room'),
        directs: all.filter(
          (room) =>
            room.kind === 'direct' && room.leadAgentId !== null && known.has(room.leadAgentId),
        ),
      }
    })
    return { asOfSeq: result.asOfSeq, ...result.data }
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
    await validateAgents([...(body.members ?? []), ...(body.leadAgentId ? [body.leadAgentId] : [])])
    let room: Room | undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const row = roomRow(sqlite, roomId)
        const before = readRoom(sqlite, roomId, row.updated_at)
        if (
          row.kind === 'direct' &&
          body.leadAgentId !== undefined &&
          body.leadAgentId !== row.lead_agent_id
        )
          throw new HttpError(409, 'conflict', 'A direct room belongs to its agent')
        const name = body.name ?? row.name
        if (sqlite.prepare('SELECT id FROM rooms WHERE name = ? AND id != ?').get(name, roomId))
          throw new HttpError(409, 'conflict', 'Room name already exists')
        sqlite
          .prepare('UPDATE rooms SET name = ?, lead_agent_id = ?, members = ? WHERE id = ?')
          .run(
            name,
            body.leadAgentId ?? row.lead_agent_id,
            body.members ? JSON.stringify([...new Set(body.members)]) : row.members,
            roomId,
          )
        room = readRoom(sqlite, roomId, now)
        return roomChanged(sqlite, roomId, now, before)
      },
    })
    return room
  })

  app.get('/api/rooms/:roomId', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    await refresh()
    const result = snapshot(db, (sqlite) => ({
      room: readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at),
      filesInPlay: roomFilesInPlay(sqlite, roomId),
      learned: roomLearned(sqlite, roomId),
    }))
    return { asOfSeq: result.asOfSeq, ...result.data }
  })

  app.get('/api/rooms/:roomId/messages', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const query = QuerySchema.parse(request.query)
    const before =
      query.before === undefined ? undefined : decodeMessageCursor(query.before, roomId)
    const page = snapshot(db, (sqlite) => messagePage(sqlite, roomId, query.limit, before))
    // Acknowledge only what this snapshot returned; later arrivals must remain unread.
    if (!before)
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          return markRoomRead(sqlite, roomId, now, page.data.items[0])
        },
      })
    return { asOfSeq: page.asOfSeq, ...page.data }
  })

  app.post('/api/rooms/:roomId/messages', mutation, async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const body = MessageBodySchema.parse(request.body)
    const to = [...new Set(body.to ?? [])]
    const known = (await agents()).map((agent) => agent.id)
    if (to.some((id) => !known.includes(id)))
      throw new HttpError(400, 'bad_request', 'Unknown agent')
    const room = db.read((sqlite) => readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at))
    const route = routeMessage(body.text, to, room, known)
    let command: CommandResult | null = modelCommand(route.model)
    const id = randomUUID()
    if (route.parsed.command?.kind === 'assign') {
      const assigned = route.parsed.command
      const task = await port.createTask(
        {
          title: assigned.title,
          assignee: assigned.agentId,
          roomId,
          ...(assigned.body === null ? {} : { body: assigned.body }),
        },
        `assign:${id}`,
      )
      command = { kind: 'assign', taskId: task.id, taskKey: task.key }
    }
    if (route.parsed.command?.kind === 'routine') {
      const routine = route.parsed.command
      if (!known.includes(routine.agentId)) throw new HttpError(400, 'bad_request', 'Unknown agent')
      const created = await port.createRoutine(
        routine.agentId,
        {
          title: routine.prompt.replace(/\s+/g, ' ').trim().slice(0, 50),
          schedule: routine.schedule,
          prompt: routine.prompt,
        },
        `routine:${id}`,
      )
      command = { kind: 'routine', routineId: created.id }
    }
    let message: Message | undefined
    // Plan first goes to the lead when it is among the recipients, otherwise to the first recipient.
    const planner =
      body.planFirst && route.routedTo.length
        ? route.routedTo.includes(room.leadAgentId ?? '')
          ? room.leadAgentId
          : route.routedTo[0]
        : undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        message = {
          id,
          roomId,
          author: { kind: 'you' },
          to,
          parts: [{ kind: 'text', text: body.text }],
          createdAt: now,
          streaming: false,
          refs: [],
        }
        const drafts = storeMessage(sqlite, message, now)
        for (const agentId of route.routedTo)
          reserveMessageRun(
            sqlite,
            {
              parentMessageId: id,
              roomId,
              agentId,
              chainId: id,
              hop: 0,
              input: agentId === planner ? route.input + PLAN_FIRST_ADDENDUM : route.input,
              agents: known,
              ...(agentId === planner ? { planFirst: true } : {}),
              ...((route.model ?? body.model) ? { model: route.model ?? body.model } : {}),
            },
            now,
          )
        // Every human message that starts a turn (or creates a task with /assign) is a brief. It is created after
        // the turns are reserved so its first status already counts them.
        if (route.routedTo.length || command?.kind === 'assign')
          drafts.push(
            ...createBrief(
              sqlite,
              {
                id,
                roomId,
                text: body.text,
                tasks:
                  command?.kind === 'assign' ? [{ taskId: command.taskId, origin: 'assign' }] : [],
              },
              now,
            ),
          )
        return drafts
      },
    })
    await routing.dispatch()
    return { message, routedTo: route.routedTo, command }
  })
  return () => routing.dispatch()
}
import { agentAdmits } from '../domain/agent-lifecycle.ts'

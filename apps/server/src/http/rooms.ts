import { randomUUID } from 'node:crypto'
import {
  AgentIdSchema,
  AgentSummarySchema,
  MessageAttachmentSchema,
  RewindRequestSchema,
  RoomTagSchema,
  type CommandResult,
  type RewindPlan,
  type RewindSkipReason,
  type Message,
  type Room,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import {
  decodeMessageCursor,
  deleteMessage,
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
import {
  createVersion,
  editableMessage,
  listVersions,
  markEdited,
  markRunsRewound,
  rewindableMessage,
  rewindScope,
  versionMessages,
  versionOfAnchor,
} from '../domain/versions.ts'
import { assertProject, listProjects } from '../domain/room-projects.ts'
import { roomFilesInPlay, roomLearned } from '../domain/room-panels.ts'
import { createBrief } from '../domain/briefs.ts'
import {
  clearRoomHold,
  holdRoomUntil,
  persistRoomHold,
  rewindingRooms,
} from '../domain/room-rewinding.ts'
import { reserveMessageRun, retryReply } from '../domain/message-runs.ts'
import { PLAN_FIRST_ADDENDUM } from '../domain/plan.ts'
import { COMMANDS } from '../domain/parse.ts'
import { routeMessage, modelCommand } from '../domain/routing.ts'
import { resolveAlias } from '../domain/model-aliases.ts'
import { RoutingDispatcher } from '../domain/routing-dispatch.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { MAX_ATTACHMENTS, type MediaStore } from '../media/store.ts'
import { attachmentNote } from '../domain/attachment-input.ts'
import { resolveAttachments } from './message-attachments.ts'
import type { AgentWorkspaces } from '../workspace/agent-workspace.ts'
import { requestIdempotency } from './idempotency.ts'

// "#launch" or "launch", optionally followed by #tag words ("#launch #q4"): tags are parsed from the name (PLAN 5.26).
const NameSchema = z
  .string()
  .regex(/^#?[a-z0-9][a-z0-9-]{0,63}( #[a-z0-9][a-z0-9-]{0,31}){0,8}$/)
  .transform((name) => (name.startsWith('#') ? name : `#${name}`))
const CreateSchema = z
  .object({
    name: NameSchema,
    leadAgentId: AgentIdSchema.optional(),
    members: z.array(AgentIdSchema).optional(),
  })
  .strict()
const PatchSchema = z
  .object({
    ...CreateSchema.partial().shape,
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    projectId: z.string().min(1).max(200).nullable().optional(),
    /** null = follow the `#tags` in the name again. */
    tags: z.array(RoomTagSchema).max(12).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0)
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
    attachments: z.array(MessageAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
    edits: z.string().min(1).max(200).optional(),
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
  media?: MediaStore,
  workspaces?: AgentWorkspaces,
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

  // /remember and /skill parse but have no write path yet (they answer 501), so the slash menu does not offer them.
  app.get('/api/commands', async () => ({
    items: COMMANDS.filter(({ name }) => name !== 'remember' && name !== 'skill'),
  }))

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
        if (body.projectId) assertProject(sqlite, body.projectId)
        sqlite
          .prepare(
            `UPDATE rooms SET name = ?, lead_agent_id = ?, members = ?, pinned = ?, archived = ?, project_id = ?, tags = ?
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
    // Acknowledge only what this snapshot returned; later arrivals must remain unread. An empty streaming
    // placeholder has no content yet, so read state stops before the oldest one (its answer is still unseen).
    const items = page.data.items
    const oldestEmpty = items.findLastIndex((item) => item.streaming && item.parts.length === 0)
    const newest = items[oldestEmpty + 1]
    if (!before)
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          return markRoomRead(sqlite, roomId, now, newest)
        },
      })
    return { asOfSeq: page.asOfSeq, ...page.data }
  })

  // Naturally idempotent, and a 204 has no JSON body for a receipt, so no Idempotency-Key handling here.
  app.delete(
    '/api/rooms/:roomId/messages/:messageId',
    { preHandler: [humanGuard(app.pairing)] },
    async (request, reply) => {
      const { roomId, messageId } = z
        .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
        .parse(request.params)
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => deleteMessage(sqlite, roomId, messageId, now),
      })
      return reply.code(204).send()
    },
  )

  // Rewind (PLAN 5.33): the person's message and everything after it become a previous version, and the agents' Hermes
  // sessions go back to just before it. One rewind per room at a time.
  const MessageParamsSchema = z.object({
    roomId: ParamsSchema.shape.roomId,
    messageId: z.string().min(1).max(200),
  })
  const rewinding = rewindingRooms
  function assertNotRewinding(roomId: string) {
    if (rewinding.has(roomId))
      throw new HttpError(409, 'conflict', 'This room is being rewound; try again in a moment')
  }
  async function rewindPlan(roomId: string, messageId: string) {
    const found = db.read((sqlite) => {
      const anchor = rewindableMessage(sqlite, roomId, messageId)
      return { anchor, scope: rewindScope(sqlite, roomId, anchor) }
    })
    const checks = await Promise.all(
      found.scope.agents.map(async (agent) => {
        const result = await port.rewindSession({
          agentId: agent.agentId,
          sessionId: agent.sessionId,
          turns: agent.turns,
          sinceMs: Date.parse(found.anchor.createdAt),
          dryRun: true,
        })
        return { agent, cannot: result.status === 'skipped' ? result.reason : null }
      }),
    )
    return { ...found, checks }
  }

  app.get(
    '/api/rooms/:roomId/messages/:messageId/rewind-plan',
    async (request): Promise<RewindPlan> => {
      const { roomId, messageId } = MessageParamsSchema.parse(request.params)
      const { scope, checks } = await rewindPlan(roomId, messageId)
      return {
        hiddenCount: scope.hiddenCount,
        blocked: scope.blocked,
        agents: checks.map(({ agent, cannot }) => ({
          agentId: agent.agentId,
          turns: agent.turns,
          cannot,
        })),
      }
    },
  )

  app.post('/api/rooms/:roomId/messages/:messageId/rewind', mutation, async (request) => {
    const { roomId, messageId } = MessageParamsSchema.parse(request.params)
    const body = RewindRequestSchema.strict().parse(request.body)
    const prior = db.read((sqlite) => {
      roomRow(sqlite, roomId)
      return versionOfAnchor(sqlite, roomId, messageId)
    })
    // Repeating a rewind that already happened returns what it did, and never touches Hermes again.
    if (prior) return { version: prior, rewound: prior.rewound, skipped: prior.skipped }
    if (rewinding.has(roomId))
      throw new HttpError(409, 'conflict', 'This room is already being rewound')
    rewinding.add(roomId)
    // A command nobody answered may still be claimed by the plugin: the room stays held until it has expired.
    let uncertainUntil: number | null = null
    try {
      const { anchor, scope, checks } = await rewindPlan(roomId, messageId)
      if (scope.blocked) throw new HttpError(409, 'conflict', scope.blocked)
      const skipped: { agentId: string; reason: RewindSkipReason }[] = body.scoreOnly
        ? scope.agents.map((agent) => ({ agentId: agent.agentId, reason: 'score_only' }))
        : checks.flatMap(({ agent, cannot }) =>
            cannot ? [{ agentId: agent.agentId, reason: cannot }] : [],
          )
      if (!body.scoreOnly && skipped.length)
        throw new HttpError(409, 'rewind_incomplete', 'Some agents cannot be rewound', {
          skipped,
          rewound: [],
        })
      const rewound: { agentId: string; turnsUndone: number }[] = []
      if (!body.scoreOnly) {
        for (const agent of scope.agents) {
          // Persisted before the command exists, so a restart can't release the room while it is still alive.
          let until = 0
          await ingest.submit({
            source: 'rooms',
            identity: randomUUID(),
            apply: ({ sqlite }) => {
              until = persistRoomHold(sqlite, roomId, Date.now())
              return []
            },
          })
          const result = await port.rewindSession({
            agentId: agent.agentId,
            sessionId: agent.sessionId,
            turns: agent.turns,
            sinceMs: Date.parse(anchor.createdAt),
          })
          if (result.status === 'skipped' && result.reason === 'no_answer') uncertainUntil = until
          if (result.status !== 'rewound') {
            const reason = result.status === 'skipped' ? result.reason : 'rewind_failed'
            throw new HttpError(409, 'rewind_incomplete', 'Some agents could not be rewound', {
              skipped: [{ agentId: agent.agentId, reason }],
              rewound,
            })
          }
          rewound.push({ agentId: agent.agentId, turnsUndone: result.turnsUndone })
          // Remembered at once: a retry after a later agent failed must not rewind this one again.
          await ingest.submit({
            source: 'rooms',
            identity: randomUUID(),
            apply: ({ sqlite, now }) => {
              markRunsRewound(sqlite, roomId, agent.agentId, anchor.createdAt, now)
              return []
            },
          })
        }
      }
      let created: ReturnType<typeof createVersion> | undefined
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => {
          // Re-checked inside the transaction: new work may have been queued while Hermes was being asked.
          const again = rewindScope(sqlite, roomId, anchor)
          if (again.blocked) throw new HttpError(409, 'conflict', again.blocked)
          created = createVersion(
            sqlite,
            {
              roomId,
              anchor,
              mode: body.mode,
              scoreOnly: Boolean(body.scoreOnly),
              rewound,
              skipped,
            },
            now,
          )
          return created.drafts
        },
      })
      return { version: created!.version, rewound, skipped }
    } finally {
      if (uncertainUntil !== null) holdRoomUntil(db.sqlite, roomId, uncertainUntil)
      else {
        rewinding.delete(roomId)
        clearRoomHold(db.sqlite, roomId)
      }
    }
  })

  app.get('/api/rooms/:roomId/versions', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const result = snapshot(db, (sqlite) => listVersions(sqlite, roomId))
    return { asOfSeq: result.asOfSeq, items: result.data }
  })

  app.get('/api/rooms/:roomId/versions/:anchorId', async (request) => {
    const { roomId, anchorId } = z
      .object({ roomId: ParamsSchema.shape.roomId, anchorId: z.string().min(1).max(200) })
      .parse(request.params)
    return db.read((sqlite) => {
      const version = versionOfAnchor(sqlite, roomId, anchorId)
      if (!version) throw new HttpError(404, 'not_found', 'Unknown version')
      return { version, items: versionMessages(sqlite, version.id) }
    })
  })

  app.post('/api/rooms/:roomId/messages/:messageId/retry', mutation, async (request, reply) => {
    assertNotRewinding(ParamsSchema.parse(request.params).roomId)
    const { roomId, messageId } = z
      .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
      .parse(request.params)
    const nonce = randomUUID()
    let replyId = ''
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        replyId = retryReply(sqlite, roomId, messageId, nonce, now)
        return []
      },
    })
    await routing.dispatch()
    return reply.code(202).send({ messageId: replyId })
  })

  // Stop (PLAN 5.25): ends the Score-started run that is writing a streaming reply. The run's cancelled status then
  // completes the reply with "This run was stopped." through the normal path.
  app.post('/api/rooms/:roomId/messages/:messageId/stop', mutation, async (request) => {
    const { roomId, messageId } = z
      .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
      .parse(request.params)
    const row = z
      .object({
        run_id: z.string().nullable(),
        agent_id: z.string().min(1),
        state: z.enum(['pending', 'active', 'completed', 'failed']),
      })
      .nullish()
      .parse(
        db.sqlite
          .prepare(
            `SELECT mr.run_id, mr.agent_id, mr.state FROM message_runs mr JOIN messages m ON m.id = mr.message_id
             WHERE mr.message_id = ? AND mr.room_id = ? AND m.deleted_at IS NULL`,
          )
          .get(messageId, roomId),
      )
    if (!row) throw new HttpError(404, 'not_found', 'Unknown message')
    if (row.state !== 'active' || !row.run_id)
      throw new HttpError(409, 'conflict', 'This reply is not being written right now')
    await port.stopRun({ agentId: row.agent_id, runId: row.run_id })
    return { ok: true }
  })

  app.post('/api/rooms/:roomId/messages', mutation, async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    assertNotRewinding(roomId)
    const body = MessageBodySchema.parse(request.body)
    // Edit and resend: checked before any side effect (a /assign task) and again inside the transaction below.
    const original = body.edits
      ? db.read((sqlite) => editableMessage(sqlite, roomId, body.edits!))
      : undefined
    const to = [...new Set(body.to ?? original?.to ?? [])]
    const known = (await agents()).map((agent) => agent.id)
    if (to.some((id) => !known.includes(id)))
      throw new HttpError(400, 'bad_request', 'Unknown agent')
    const attached = await resolveAttachments(body.attachments ?? [], media, workspaces, known)
    const mediaIds = attached.mediaIds
    const room = db.read((sqlite) => readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at))
    const route = routeMessage(body.text, to, room, known)
    let command: CommandResult | null = modelCommand(route.model)
    // `/model <alias>` names the model the alias stands for on each recipient (aliases belong to a profile).
    const typedModel = route.model ?? body.model
    const modelOf = new Map<string, { model: string; provider?: string }>()
    if (typedModel)
      for (const agentId of route.routedTo) {
        const alias = await resolveAlias(port, agentId, typedModel)
        modelOf.set(
          agentId,
          alias
            ? { model: alias.model, ...(alias.provider ? { provider: alias.provider } : {}) }
            : { model: typedModel },
        )
      }
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
    // What each addressed agent is told about the attachments (and, for documents, saving them into its workspace).
    const notes = new Map<string, string>()
    const notices: string[] = []
    const day = new Date(clock()).toISOString().slice(0, 10)
    if (attached.documents.length || attached.references.length)
      for (const agentId of planner ? [planner] : route.routedTo) {
        const made = await attachmentNote({
          agentId,
          documents: attached.documents,
          references: attached.references,
          day,
          workspace: () => {
            if (!workspaces) throw new Error('workspaces are not available')
            return workspaces.open(agentId, (event) =>
              request.log.info({ agentId, workspace: event }, 'workspace write'),
            )
          },
        })
        notes.set(agentId, made.note)
        notices.push(...made.notices)
        for (const { mediaId, path } of made.saved) {
          const part = attached.parts.find((p) => p.kind === 'document' && p.mediaId === mediaId)
          if (part?.kind === 'document') part.saved = [...(part.saved ?? []), { agentId, path }]
        }
      }
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        message = {
          id,
          roomId,
          author: { kind: 'you' },
          to,
          parts: [{ kind: 'text', text: body.text }, ...attached.parts],
          createdAt: now,
          streaming: false,
          refs: [],
          ...(original ? { edits: original.id } : {}),
        }
        if (original) editableMessage(sqlite, roomId, original.id)
        // Inside the same transaction, so an item deleted since the check above fails the whole message.
        media?.retain(sqlite, mediaIds, now)
        const drafts = storeMessage(sqlite, message, now)
        if (original) drafts.push(...markEdited(sqlite, roomId, original, id, now))
        // Plan first admits only the planner; the others are named in its prompt and start from the plan.
        const team = route.routedTo.filter((agentId) => agentId !== planner)
        const teamNote = team.length
          ? `\n\nThe request was addressed to the team: ${route.routedTo.map((id) => `@${id}`).join(', ')}.`
          : ''
        for (const agentId of planner ? [planner] : route.routedTo)
          reserveMessageRun(
            sqlite,
            {
              parentMessageId: id,
              roomId,
              agentId,
              chainId: id,
              hop: 0,
              input:
                agentId === planner
                  ? route.input + (notes.get(agentId) ?? '') + teamNote + PLAN_FIRST_ADDENDUM
                  : route.input + (notes.get(agentId) ?? ''),
              agents: known,
              ...(agentId === planner ? { planFirst: true } : {}),
              ...(modelOf.has(agentId) ? modelOf.get(agentId) : {}),
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
    return { message, routedTo: route.routedTo, command, ...(notices.length ? { notices } : {}) }
  })
  return () => routing.dispatch()
}
import { agentAdmits } from '../domain/agent-lifecycle.ts'

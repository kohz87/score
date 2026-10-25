import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ChatCreateRequestSchema,
  DirectChatsResponseSchema,
  ExchangeDecisionRequestSchema,
  ExchangesResponseSchema,
  JobCreateRequestSchema,
  JobRenameRequestSchema,
  JobResultsSchema,
  WorkbenchSchema,
  JobSchema,
  JobsResponseSchema,
  RoomPinsResponseSchema,
  ShareToJobRequestSchema,
  TeamRoomResponseSchema,
} from '@score/contract'
import type { FastifyInstance, preHandlerHookHandler, onSendHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { decideExchange, stopJob, type Decided } from '../domain/exchanges/decisions.ts'
import { jobResults } from '../domain/exchanges/results.ts'
import { jobWorkbench } from '../domain/exchanges/workbench.ts'
import {
  createJob,
  jobFromRow,
  jobRow,
  listExchanges,
  listJobs,
} from '../domain/exchanges/store.ts'
import {
  closeJob,
  deleteJob,
  jobDeleted,
  renameJob,
  reopenJob,
  restoreJob,
} from '../domain/exchanges/job-life.ts'
import type { HermesPort } from '../hermes/index.ts'
import { freeRoomName, insertRoom, readRoom, roomChanged, roomRow } from '../domain/rooms.ts'
import { listPins, pinMessage, shareMessage, unpinMessage } from '../domain/exchanges/sharing.ts'
import { teamRoomId } from '../domain/team-room.ts'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft, Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'

// Jobs and their exchanges (contract §5 "Jobs", PLAN 11.1b).
export function registerJobRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
    /** Starts the turns a decision queued. */
    redispatch: () => Promise<void>
  },
): void {
  const { db, ingest, port, mutation, redispatch } = deps
  const ExchangeParams = z.object({ exchangeId: z.string().min(1).max(64) })

  /** Applies a decision in one transaction, then stops what was running and starts what was queued. */
  async function decide(apply: (sqlite: DatabaseSync, now: string) => Decided) {
    let running: Decided['running'] = []
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const decided = apply(sqlite, now)
        running = decided.running
        return decided.drafts
      },
    })
    // A run that won't stop is reported by its own completion; the exchange is already stopped.
    await Promise.allSettled(running.map((run) => port.stopRun(run)))
    await redispatch()
  }

  // PLAN 11.1c: the person's answer to a paused or stuck exchange, and a job's Stop.
  app.post('/api/exchanges/:exchangeId/decision', mutation, async (request) => {
    const { exchangeId } = ExchangeParams.parse(request.params)
    const body = ExchangeDecisionRequestSchema.parse(request.body)
    await decide((sqlite, now) => decideExchange(sqlite, exchangeId, body, now))
    return { ok: true }
  })
  app.post('/api/jobs/:jobId/stop', mutation, async (request) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(64) }).parse(request.params)
    await decide((sqlite, now) => stopJob(sqlite, jobId, now))
    return { ok: true }
  })
  const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
  const JobParams = z.object({ jobId: z.string().min(1).max(64) })

  // Decision 121 (D6): the job menu's rename, close and reopen, and delete with undo.
  async function jobChange(
    jobId: string,
    apply: (sqlite: DatabaseSync, now: string) => DomainEventDraft[],
  ) {
    let job: unknown = null
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const drafts = apply(sqlite, now)
        const row = jobRow(sqlite, jobId)
        job = row ? jobFromRow(sqlite, row) : null
        return drafts
      },
    })
    return job
  }
  app.patch('/api/jobs/:jobId', mutation, async (request) => {
    const { jobId } = JobParams.parse(request.params)
    const { title } = JobRenameRequestSchema.parse(request.body)
    return JobSchema.parse(
      await jobChange(jobId, (sqlite, now) => renameJob(sqlite, jobId, title, now)),
    )
  })
  app.post('/api/jobs/:jobId/close', mutation, async (request) => {
    const { jobId } = JobParams.parse(request.params)
    return JobSchema.parse(await jobChange(jobId, (sqlite, now) => closeJob(sqlite, jobId, now)))
  })
  app.post('/api/jobs/:jobId/reopen', mutation, async (request) => {
    const { jobId } = JobParams.parse(request.params)
    return JobSchema.parse(await jobChange(jobId, (sqlite, now) => reopenJob(sqlite, jobId, now)))
  })
  app.delete('/api/jobs/:jobId', mutation, async (request, reply) => {
    const { jobId } = JobParams.parse(request.params)
    await jobChange(jobId, (sqlite, now) => deleteJob(sqlite, jobId, now))
    return reply.code(204).send()
  })
  app.post('/api/jobs/:jobId/restore', mutation, async (request) => {
    const { jobId } = JobParams.parse(request.params)
    return JobSchema.parse(await jobChange(jobId, (sqlite, now) => restoreJob(sqlite, jobId, now)))
  })

  app.get('/api/rooms/:roomId/jobs', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const result = snapshot(db, (sqlite) => {
      roomRow(sqlite, roomId)
      return listJobs(sqlite, roomId)
    })
    return JobsResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  app.post('/api/rooms/:roomId/jobs', mutation, async (request, reply) => {
    const { roomId } = RoomParams.parse(request.params)
    const body = JobCreateRequestSchema.parse(request.body)
    let created: unknown
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const { title, ...options } = body
        const made = createJob(sqlite, roomId, title, now, options)
        created = made.job
        return made.drafts
      },
    })
    return reply.code(201).send(JobSchema.parse(created))
  })

  app.get('/api/jobs/:jobId/results', async (request) => {
    const { jobId } = JobParams.parse(request.params)
    if (db.read((sqlite) => jobDeleted(sqlite, jobId)))
      throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
    const result = snapshot(db, (sqlite) => jobResults(sqlite, jobId))
    return JobResultsSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  // Read-only (PLAN 11.6a): no Workbench route types, clicks or takes over anything.
  app.get('/api/jobs/:jobId/workbench', async (request) => {
    const { jobId } = JobParams.parse(request.params)
    if (db.read((sqlite) => jobDeleted(sqlite, jobId)))
      throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
    const result = snapshot(db, (sqlite) => jobWorkbench(sqlite, jobId))
    return WorkbenchSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  app.get('/api/jobs/:jobId/exchanges', async (request) => {
    const { jobId } = JobParams.parse(request.params)
    if (db.read((sqlite) => jobDeleted(sqlite, jobId)))
      throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
    const result = snapshot(db, (sqlite) => {
      if (!jobRow(sqlite, jobId)) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
      return listExchanges(sqlite, jobId)
    })
    return ExchangesResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  // PLAN 11.2: the team room, one-to-ones, sharing and pins.
  const now = () => new Date().toISOString()
  app.get('/api/team-room', async () => {
    const result = snapshot(db, (sqlite) => {
      const id = teamRoomId(sqlite)
      if (!id)
        throw new HttpError(
          404,
          'not_ready',
          'The team room appears once Score has listed your agents.',
        )
      return { room: readRoom(sqlite, id, now()), jobs: listJobs(sqlite, id) }
    })
    return TeamRoomResponseSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  const AgentParams = z.object({ agentId: z.string().min(1).max(128) })
  const directRoomOf = (sqlite: DatabaseSync, agentId: string) =>
    (
      sqlite
        .prepare("SELECT id FROM rooms WHERE kind = 'direct' AND lead_agent_id = ?")
        .get(agentId) as { id: string } | undefined
    )?.id ?? null

  app.get('/api/agents/:agentId/direct', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    const result = snapshot(db, (sqlite) => {
      const id = directRoomOf(sqlite, agentId)
      if (!id) return { room: null, chats: [] }
      // Newest activity first: "Earlier chats".
      const chats = listJobs(sqlite, id).sort((a, b) =>
        (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
      )
      return { room: readRoom(sqlite, id, now()), chats }
    })
    return DirectChatsResponseSchema.parse({ asOfSeq: result.asOfSeq, ...result.data })
  })

  app.post('/api/agents/:agentId/chats', mutation, async (request, reply) => {
    const { agentId } = AgentParams.parse(request.params)
    const body = ChatCreateRequestSchema.parse(request.body ?? {})
    const agent = (await port.listAgents()).find((item) => item.id === agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    let created: unknown
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const drafts = []
        let roomId = directRoomOf(sqlite, agentId)
        // The agent's one-to-one home, made on first use as the room list does.
        if (!roomId) {
          roomId = randomUUID()
          insertRoom(
            sqlite,
            {
              id: roomId,
              name: freeRoomName(sqlite, agent.name),
              kind: 'direct',
              leadAgentId: agentId,
              members: [agentId],
            },
            now,
          )
          drafts.push(...roomChanged(sqlite, roomId, now))
        }
        const made = createJob(sqlite, roomId, body.title ?? 'New chat', now)
        created = made.job
        return [...drafts, ...made.drafts]
      },
    })
    return reply.code(201).send(JobSchema.parse(created))
  })

  app.post('/api/messages/:messageId/share', mutation, async (request, reply) => {
    const { messageId } = z.object({ messageId: z.string().min(1).max(200) }).parse(request.params)
    const body = ShareToJobRequestSchema.parse(request.body)
    let shared = ''
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const result = shareMessage(sqlite, messageId, body.jobId, now)
        shared = result.messageId
        return result.drafts
      },
    })
    return reply.code(201).send({ messageId: shared })
  })

  const PinParams = z.object({
    roomId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(200),
  })
  app.get('/api/rooms/:roomId/pins', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    return RoomPinsResponseSchema.parse({
      items: db.read((sqlite) => {
        roomRow(sqlite, roomId)
        return listPins(sqlite, roomId)
      }),
    })
  })
  app.post('/api/rooms/:roomId/pins/:messageId', mutation, async (request, reply) => {
    const { roomId, messageId } = PinParams.parse(request.params)
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => pinMessage(sqlite, roomId, messageId, now),
    })
    return reply.code(204).send()
  })
  app.delete('/api/rooms/:roomId/pins/:messageId', mutation, async (request, reply) => {
    const { roomId, messageId } = PinParams.parse(request.params)
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite }) => unpinMessage(sqlite, roomId, messageId),
    })
    return reply.code(204).send()
  })
}

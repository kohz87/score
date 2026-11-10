import {
  AgentEffortsSchema,
  ChatEffortRequestSchema,
  ChatEffortSchema,
  ChatEffortsResponseSchema,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, onSendHookHandler, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import {
  chatEffortsOfAgent,
  chatEffortsOfRoom,
  effortLevelsOf,
  setChatEffort,
} from '../domain/chat-efforts.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
const MemberParams = RoomParams.extend({ agentId: z.string().min(1).max(256) })
const AgentParams = z.object({ agentId: z.string().min(1).max(256) })

/** Decision 178 (docs/API-CONTRACT.md §20): an agent's effort in one chat. */
export function registerChatEffortRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: Pick<HermesPort, 'listAgents' | 'readModelSettings'>
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
  },
): void {
  const { db, ingest, port, mutation } = deps

  app.get('/api/rooms/:roomId/efforts', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    return ChatEffortsResponseSchema.parse({
      items: db.read((sqlite) => chatEffortsOfRoom(sqlite, roomId)),
    })
  })

  app.put('/api/rooms/:roomId/efforts/:agentId', mutation, async (request) => {
    const { roomId, agentId } = MemberParams.parse(request.params)
    const { effort } = ChatEffortRequestSchema.parse(request.body)
    const members = db.read(
      (sqlite) =>
        sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(roomId) as
          { members: string } | undefined,
    )
    if (!members) throw new HttpError(404, 'not_found', 'Couldn’t find that chat.')
    if (!z.array(z.string()).parse(JSON.parse(members.members)).includes(agentId))
      throw new HttpError(400, 'bad_request', `${agentId} isn’t in this chat.`)
    const levels = db.read((sqlite) => effortLevelsOf(sqlite, agentId))
    if (effort !== null && !levels.includes(effort))
      throw new HttpError(
        400,
        'bad_request',
        levels.length
          ? `${agentId}’s model takes: ${levels.join(', ')}.`
          : `${agentId} has no effort Score can set.`,
      )
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => setChatEffort(sqlite, roomId, agentId, effort, now),
    })
    return effort === null
      ? { roomId, agentId, effort: null }
      : ChatEffortSchema.parse({ roomId, agentId, effort })
  })

  app.get('/api/agents/:agentId/efforts', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    const agent = (await port.listAgents()).find((one) => one.id === agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const coding = db.read(
      (sqlite) =>
        sqlite.prepare('SELECT effort FROM coding_agents WHERE id = ?').get(agentId) as
          { effort: string | null } | undefined,
    )
    // A Hermes agent's own effort comes from its config; one Hermes can't read now is shown as its default.
    const own = coding
      ? coding.effort
      : await port
          .readModelSettings(agentId)
          .then((settings) => settings.effort)
          .catch(() => null)
    return AgentEffortsSchema.parse({
      agentId,
      own,
      levels: db.read((sqlite) => effortLevelsOf(sqlite, agentId)),
      chats: db.read((sqlite) => chatEffortsOfAgent(sqlite, agentId)),
    })
  })
}

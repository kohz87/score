import {
  AgentEffortsSchema,
  ChatEffortRequestSchema,
  ChatEffortChangeSchema,
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
  isMember,
  setChatEffort,
} from '../domain/chat-efforts.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'

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
    const result = snapshot(db, (sqlite) => chatEffortsOfRoom(sqlite, roomId))
    return ChatEffortsResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  app.put('/api/rooms/:roomId/efforts/:agentId', mutation, async (request) => {
    const { roomId, agentId } = MemberParams.parse(request.params)
    const { effort } = ChatEffortRequestSchema.parse(request.body)
    const room = db.read((sqlite) => sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId))
    if (!room) throw new HttpError(404, 'not_found', 'Couldn’t find that chat.')
    // Going back to its own is always allowed, so a member taken out can still be cleared.
    if (effort !== null && !db.read((sqlite) => isMember(sqlite, roomId, agentId)))
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
    return ChatEffortChangeSchema.parse({ roomId, agentId, effort })
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
    // A Hermes agent's own effort comes from its config. Null means the model's default, so a read that fails says so
    // rather than claiming it.
    const own = coding
      ? coding.effort
      : await port
          .readModelSettings(agentId)
          .then((settings) => settings.effort)
          .catch(() => {
            throw new HttpError(503, 'hermes_unavailable', `Couldn’t read ${agentId}’s own effort.`)
          })
    return AgentEffortsSchema.parse({
      agentId,
      own,
      levels: db.read((sqlite) => effortLevelsOf(sqlite, agentId)),
      chats: db.read((sqlite) => chatEffortsOfAgent(sqlite, agentId)),
    })
  })
}

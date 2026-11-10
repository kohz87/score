import {
  AgentChatModelsSchema,
  ChatModelChangeSchema,
  ChatModelRequestSchema,
  ChatModelsResponseSchema,
  type ChatModel,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, onSendHookHandler, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { isMember } from '../domain/chat-efforts.ts'
import { chatModelsOfAgent, chatModelsOfRoom, setChatModel } from '../domain/chat-models.ts'
import { resolveAlias } from '../domain/model-aliases.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'

const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
const MemberParams = RoomParams.extend({ agentId: z.string().min(1).max(256) })
const AgentParams = z.object({ agentId: z.string().min(1).max(256) })

/** Decision 182 (docs/API-CONTRACT.md §21): an agent's model in one chat. */
export function registerChatModelRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: Pick<HermesPort, 'listAgents' | 'readModelSettings' | 'listModels'>
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
  },
): void {
  const { db, ingest, port, mutation } = deps

  app.get('/api/rooms/:roomId/models', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const result = snapshot(db, (sqlite) => chatModelsOfRoom(sqlite, roomId))
    return ChatModelsResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  app.put('/api/rooms/:roomId/models/:agentId', mutation, async (request) => {
    const { roomId, agentId } = MemberParams.parse(request.params)
    const body = ChatModelRequestSchema.parse(request.body)
    const room = db.read((sqlite) => sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId))
    if (!room) throw new HttpError(404, 'not_found', 'Couldn’t find that chat.')
    // Going back to its own is always allowed, so a member taken out can still be cleared.
    if (body.model !== null && !db.read((sqlite) => isMember(sqlite, roomId, agentId)))
      throw new HttpError(400, 'bad_request', `${agentId} isn’t in this chat.`)
    const picked =
      body.model === null ? null : await choose(agentId, body.model, body.provider ?? null)
    // Undo sends the exact model and provider it replaced, with the label (an alias) it was chosen by.
    const chosen = picked && body.label ? { ...picked, label: body.label } : picked
    let replaced: ChatModel | null = null
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        // Checked again in the write: the agent may have been taken out while the model was being looked up.
        if (chosen !== null && !isMember(sqlite, roomId, agentId))
          throw new HttpError(400, 'bad_request', `${agentId} isn’t in this chat.`)
        const result = setChatModel(sqlite, roomId, agentId, chosen, now)
        replaced = result.replaced
        return result.drafts
      },
    })
    return ChatModelChangeSchema.parse({
      roomId,
      agentId,
      current: chosen ? { roomId, agentId, ...chosen } : null,
      replaced,
    })
  })

  app.get('/api/agents/:agentId/chat-models', async (request) => {
    const { agentId } = AgentParams.parse(request.params)
    return AgentChatModelsSchema.parse({
      agentId,
      chats: db.read((sqlite) => chatModelsOfAgent(sqlite, agentId)),
    })
  })

  /**
   * What a chat runs: a coding agent takes the name as its CLI's `--model` (one of its own program's models; the
   * picker lists them, and a name its CLI refuses fails that turn visibly). A Hermes agent's alias is resolved to the
   * model and provider it stands for; the model must be one Hermes lists as available, when Hermes can list them. A
   * name several providers offer needs the provider (a pick from the list sends it).
   */
  async function choose(
    agentId: string,
    name: string,
    provider: string | null,
  ): Promise<{ model: string; provider: string | null; label: string }> {
    const coding = db.read((sqlite) =>
      sqlite.prepare('SELECT 1 FROM coding_agents WHERE id = ?').get(agentId),
    )
    if (coding) return { model: name, provider: null, label: name }
    if (!(await port.listAgents()).some((agent) => agent.id === agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    const alias = provider ? null : await resolveAlias(port, agentId, name)
    const label = alias ? name.trim().toLowerCase() : name
    const model = alias ? alias.model : name
    const wanted = alias ? alias.provider : provider
    // The whole catalogue: a search for the name would come back empty for an unknown model and look like no catalogue.
    const listed = await port.listModels(undefined, undefined, Infinity).catch(() => null)
    if (!listed || !listed.length) return { model, provider: wanted, label }
    const matches = listed.filter(
      (option) => option.model === model && (!wanted || option.provider === wanted),
    )
    if (!matches.length) {
      // An alias Hermes routes itself (a model the catalogue doesn't list) is still the person's own setting.
      if (alias) return { model, provider: wanted, label }
      throw new HttpError(400, 'bad_request', `${name} isn’t available for ${agentId}.`)
    }
    if (new Set(matches.map((option) => option.provider)).size > 1)
      throw new HttpError(
        400,
        'bad_request',
        `Several providers offer ${model}: pick it from the list.`,
      )
    const match = matches[0]!
    if (!match.available)
      throw new HttpError(400, 'bad_request', match.reason ?? `${model} isn’t available now.`)
    return { model, provider: wanted ?? (match.provider || null), label }
  }
}

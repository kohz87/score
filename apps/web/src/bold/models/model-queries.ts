import {
  AgentChatModelsSchema,
  ChatModelChangeSchema,
  ChatModelsResponseSchema,
  ModelChangedSchema,
  RoutinesPinnedSchema,
  type AgentChatModels,
  type AgentId,
  type ChatModel,
  type ChatModelChange,
  type ChatModelsResponse,
  type RoutinesPinned,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { useStreamQuery } from '../../data/query-client.ts'

const roomPath = (roomId: string) => `rooms/${encodeURIComponent(roomId)}/models`
const agentPath = (agentId: string) => `agents/${encodeURIComponent(agentId)}/chat-models`

export type RoomModels = Omit<ChatModelsResponse, 'asOfSeq'>

/**
 * One chat's models, kept live by `model.changed` (decision 182). The GET has no stream position of its own use, so a
 * replayed event only sets an agent's model to what it says, and replaying in order ends on the newest one.
 */
export function roomModelsQuery(roomId: string) {
  return defineStreamQuery<RoomModels>({
    key: ['bold', 'models', 'room', roomId],
    async fetch(signal) {
      const { asOfSeq, items } = ChatModelsResponseSchema.parse(
        await apiFetch(roomPath(roomId), { signal }),
      )
      return { asOfSeq, data: { items } }
    },
    types: ['model.changed'],
    reduce(data, event) {
      if (event.type !== 'model.changed') return data
      const change = ModelChangedSchema.parse(event.data)
      if (change.roomId !== roomId) return data
      const others = data.items.filter((item) => item.agentId !== change.agentId)
      if (change.model === null) return { items: others }
      const known = data.items.find((item) => item.agentId === change.agentId)
      const next: ChatModel = {
        roomId,
        agentId: change.agentId,
        model: change.model,
        provider: known && known.model === change.model ? known.provider : null,
        label: change.label ?? change.model,
      }
      return { items: [...others, next] }
    },
  })
}

export function useRoomModels(roomId: string) {
  return useStreamQuery(roomModelsQuery(roomId)).data ?? { items: [] }
}

/** The model an agent has in this chat, or null when it uses its own. */
export function chatModelOf(items: ChatModel[], agentId: string): ChatModel | null {
  return items.find((item) => item.agentId === agentId) ?? null
}

/** A one-off read, for a command that must act on the current value rather than what is on screen. */
export async function fetchRoomModels(roomId: string): Promise<ChatModelsResponse> {
  return ChatModelsResponseSchema.parse(await apiFetch(roomPath(roomId)))
}

export const agentChatModelsKey = (agentId: string) =>
  ['bold', 'agent-chat-models', agentId] as const

/** The chats where an agent runs another model than its own. */
export function useAgentChatModels(agentId: AgentId | null) {
  return useQuery({
    queryKey: agentChatModelsKey(agentId ?? ''),
    enabled: Boolean(agentId),
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }): Promise<AgentChatModels> =>
      AgentChatModelsSchema.parse(await apiFetch(agentPath(agentId!), { signal })),
  })
}

/** Sets one agent's model in a chat; null goes back to its own. `replaced` is what Undo puts back. */
export async function putRoomModel(
  roomId: string,
  agentId: string,
  model: string | null,
  provider?: string | null,
): Promise<ChatModelChange> {
  return ChatModelChangeSchema.parse(
    await apiFetch(`${roomPath(roomId)}/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify(provider ? { model, provider } : { model }),
    }),
  )
}

/** Locks the repeating jobs that follow the agent's model onto the model it has now, before it is changed. */
export async function pinRoutines(agentId: string): Promise<RoutinesPinned> {
  return RoutinesPinnedSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/routines/pin`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({}),
    }),
  )
}

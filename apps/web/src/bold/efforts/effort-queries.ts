import {
  AgentEffortsSchema,
  ChatEffortSchema,
  ChatEffortsResponseSchema,
  EffortChangedSchema,
  EffortWordSchema,
  type AgentEfforts,
  type AgentId,
  type ChatEffortsResponse,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { useStreamQuery } from '../../data/query-client.ts'

/** The PUT answers with the effort, or null when it went back to the agent's own. */
const PutAnswerSchema = ChatEffortSchema.omit({ effort: true }).extend({
  effort: EffortWordSchema.nullable(),
})
type ChatEffortAnswer = ReturnType<typeof PutAnswerSchema.parse>

const roomPath = (roomId: string) => `rooms/${encodeURIComponent(roomId)}/efforts`
const agentPath = (agentId: string) => `agents/${encodeURIComponent(agentId)}/efforts`

/** A chat's efforts plus the last change Score made itself (`reason: model`), which the chat says in a line. */
export type RoomEfforts = Omit<ChatEffortsResponse, 'asOfSeq'> & {
  notice: { seq: number; agentId: string } | null
}

/**
 * One chat's efforts, kept live by `effort.changed`. The GET has no `asOfSeq`, so the snapshot is taken as 0: a replayed
 * event only sets an agent's effort to what it says, so replaying in order ends on the newest one.
 */
export function roomEffortsQuery(roomId: string) {
  return defineStreamQuery<RoomEfforts>({
    key: ['bold', 'efforts', 'room', roomId],
    async fetch(signal) {
      const { asOfSeq, items } = ChatEffortsResponseSchema.parse(
        await apiFetch(roomPath(roomId), { signal }),
      )
      return { asOfSeq, data: { items, notice: null } }
    },
    types: ['effort.changed'],
    reduce(data, event) {
      if (event.type !== 'effort.changed') return data
      const change = EffortChangedSchema.parse(event.data)
      if (change.roomId !== roomId) return data
      const others = data.items.filter((item) => item.agentId !== change.agentId)
      return {
        items:
          change.effort === null
            ? others
            : [...others, { roomId, agentId: change.agentId, effort: change.effort }],
        notice:
          change.reason === 'model' ? { seq: event.seq, agentId: change.agentId } : data.notice,
      }
    },
  })
}

export function useRoomEfforts(roomId: string) {
  return useStreamQuery(roomEffortsQuery(roomId)).data ?? { items: [], notice: null }
}

/** The effort an agent has in this chat, or null when it uses its own. */
export function chatEffortOf(items: ChatEffortsResponse['items'], agentId: string): string | null {
  return items.find((item) => item.agentId === agentId)?.effort ?? null
}

/** A one-off read, for a command that must act on the current value rather than what is on screen. */
export async function fetchRoomEfforts(roomId: string): Promise<ChatEffortsResponse> {
  return ChatEffortsResponseSchema.parse(await apiFetch(roomPath(roomId)))
}

export const agentEffortsKey = (agentId: string) => ['bold', 'agent-efforts', agentId] as const

/** An agent's own effort, the levels a chat can take, and the chats it is set differently in. */
export function agentEffortsQuery(agentId: AgentId | null) {
  return {
    queryKey: agentEffortsKey(agentId ?? ''),
    enabled: Boolean(agentId),
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<AgentEfforts> =>
      AgentEffortsSchema.parse(await apiFetch(agentPath(agentId!), { signal })),
  }
}

export function useAgentEfforts(agentId: AgentId | null) {
  return useQuery(agentEffortsQuery(agentId))
}

/** Sets one agent's effort in a chat; null goes back to its own. Idempotent, so a retry is safe. */
export async function putRoomEffort(
  roomId: string,
  agentId: string,
  effort: string | null,
): Promise<ChatEffortAnswer> {
  return PutAnswerSchema.parse(
    await apiFetch(`${roomPath(roomId)}/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({ effort }),
    }),
  )
}

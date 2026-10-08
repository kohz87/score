import {
  AgentIdSchema,
  AgentSummarySchema,
  MessageSchema,
  RoomSchema,
  StreamHelloSchema,
  type Message,
  type StreamEvent,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'

// Endpoint envelopes are composed here because the contract exports entity schemas only.
const snapshotSchema = RoomSchema.pick({}).extend({
  asOfSeq: StreamHelloSchema.shape.data.shape.headSeq,
})
const RoomsSnapshotSchema = snapshotSchema.extend({
  rooms: RoomSchema.array(),
  directs: RoomSchema.array(),
})
const AgentsSnapshotSchema = snapshotSchema.extend({
  items: AgentSummarySchema.array(),
})
const RoomSnapshotSchema = snapshotSchema.extend({
  room: RoomSchema,
  filesInPlay: RoomSchema.shape.name.array(),
  learned: RoomSchema.pick({})
    .extend({
      text: RoomSchema.shape.name,
      savedTo: AgentIdSchema.array(),
      at: MessageSchema.shape.createdAt,
    })
    .array(),
})
const MessagesSnapshotSchema = snapshotSchema.extend({
  items: MessageSchema.array(),
  nextCursor: RoomSchema.shape.name.nullable(),
})

export const roomsQuery = defineStreamQuery({
  key: ['chat', 'rooms'],
  async fetch() {
    const { asOfSeq, ...data } = RoomsSnapshotSchema.parse(await apiFetch('rooms'))
    return { asOfSeq, data }
  },
  types: ['room.upserted'],
  reduce(data, event) {
    if (event.type !== 'room.upserted') return data
    const rooms = data.rooms.filter((room) => room.id !== event.data.id)
    const directs = data.directs.filter((room) => room.id !== event.data.id)
    const target = event.data.kind === 'room' ? rooms : directs
    target.push(event.data)
    const sort = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
    return { rooms: rooms.sort(sort), directs: directs.sort(sort) }
  },
})
export const agentsQuery = defineStreamQuery({
  key: ['chat', 'agents'],
  async fetch() {
    const { asOfSeq, items } = AgentsSnapshotSchema.parse(await apiFetch('agents'))
    return { asOfSeq, data: items }
  },
  types: ['agent.updated'],
  reduce(data, event) {
    if (event.type !== 'agent.updated') return data
    return [...data.filter((agent) => agent.id !== event.data.id), event.data]
  },
})
export function roomQuery(roomId: string) {
  return defineStreamQuery({
    key: ['chat', 'room', roomId],
    async fetch() {
      const { asOfSeq, room } = RoomSnapshotSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}`),
      )
      return { asOfSeq, data: room }
    },
    types: ['room.upserted'],
    reduce(data, event) {
      return event.type === 'room.upserted' && event.data.id === roomId ? event.data : data
    },
  })
}
export type MessagePageData = {
  items: Message[]
  nextCursor: string | null
  typing: Record<string, string>
}
export function reduceMessages(
  data: MessagePageData,
  event: StreamEvent,
  roomId: string,
  latest: boolean,
) {
  if (!('roomId' in event.data) || event.data.roomId !== roomId) return data
  if (event.type === 'typing') {
    const typing = { ...data.typing }
    if (event.data.text === null) delete typing[event.data.agentId]
    else typing[event.data.agentId] = event.data.text
    return { ...data, typing }
  }
  if (event.type === 'message.created') {
    if (!latest) return data
    return {
      ...data,
      items: [event.data, ...data.items.filter((item) => item.id !== event.data.id)],
    }
  }
  if (event.type !== 'message.delta' && event.type !== 'message.completed') return data
  const update = event
  return {
    ...data,
    items: data.items.map((message) => {
      if (message.id !== update.data.messageId) return message
      if (update.type === 'message.completed') return { ...message, streaming: false }
      const parts = [...message.parts]
      const index = parts.findLastIndex((part) => part.kind === 'text')
      const part = parts[index]
      if (part?.kind === 'text')
        parts[index] = { kind: 'text', text: part.text + update.data.append }
      else parts.push({ kind: 'text', text: update.data.append })
      return { ...message, parts }
    }),
  }
}
export function messagesQuery(roomId: string, before: string | null = null) {
  return defineStreamQuery<MessagePageData>({
    key: ['chat', 'messages', roomId, before],
    async fetch() {
      const params = new URLSearchParams({ limit: '50' })
      if (before !== null) params.set('before', before)
      const { asOfSeq, ...page } = MessagesSnapshotSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`),
      )
      return { asOfSeq, data: { ...page, typing: {} } }
    },
    types: ['message.created', 'message.delta', 'message.completed', 'typing'],
    reduce: (data, event) => reduceMessages(data, event, roomId, before === null),
  })
}

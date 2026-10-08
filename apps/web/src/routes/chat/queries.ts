import {
  AgentsSnapshotSchema,
  ApprovalsPageSchema,
  type Approval,
  MessagePageSchema,
  RoomDetailSnapshotSchema,
  RoomsSnapshotSchema,
  type Message,
  type StreamEvent,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'

const RoomSnapshotSchema = RoomDetailSnapshotSchema
const MessagesSnapshotSchema = MessagePageSchema

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
function applyLane(
  message: Message,
  event: Extract<StreamEvent, { type: 'lane.upserted' }>,
): Message {
  const { briefId, agentId, block } = event.data
  if (!message.parts.some((part) => part.kind === 'plan' && part.briefId === briefId))
    return message
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.kind !== 'plan' || part.briefId !== briefId) return part
      const lanes = part.lanes.some((lane) => lane.agentId === agentId)
        ? part.lanes
        : [...part.lanes, { agentId, blocks: [] }]
      return {
        ...part,
        lanes: lanes.map((lane) =>
          lane.agentId !== agentId
            ? lane
            : {
                ...lane,
                blocks: lane.blocks.some((item) => item.id === block.id)
                  ? lane.blocks.map((item) => (item.id === block.id ? block : item))
                  : [...lane.blocks, block],
              },
        ),
      }
    }),
  }
}
export function reduceMessages(
  data: MessagePageData,
  event: StreamEvent,
  roomId: string,
  latest: boolean,
) {
  if (event.type === 'lane.upserted' && event.data.briefId)
    return { ...data, items: data.items.map((message) => applyLane(message, event)) }
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
    types: ['message.created', 'message.delta', 'message.completed', 'typing', 'lane.upserted'],
    reduce: (data, event) => reduceMessages(data, event, roomId, before === null),
  })
}

// All approvals, newest first, kept live by the stream; cards look theirs up by id.
export const approvalsQuery = defineStreamQuery<Approval[]>({
  key: ['chat', 'approvals'],
  async fetch() {
    const { asOfSeq, items } = ApprovalsPageSchema.parse(await apiFetch('approvals?status=all'))
    return { asOfSeq, data: items }
  },
  types: ['approval.requested', 'approval.updated'],
  reduce(data, event) {
    if (event.type !== 'approval.requested' && event.type !== 'approval.updated') return data
    const approval = event.data
    return [approval, ...data.filter((item) => item.id !== approval.id)]
  },
})

// Files in play / Learned here are read models the server computes on request, so stream events
// only trigger a refetch (see RoomPanels); the reducer never changes them.
export function roomPanelsQuery(roomId: string) {
  return defineStreamQuery({
    key: ['chat', 'room-panels', roomId],
    async fetch() {
      const { asOfSeq, filesInPlay, learned } = RoomSnapshotSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}`),
      )
      return { asOfSeq, data: { filesInPlay, learned } }
    },
    types: [],
    reduce: (data) => data,
  })
}

import {
  ExchangeSchema,
  ExchangesResponseSchema,
  JobSchema,
  JobsResponseSchema,
  MessagePageSchema,
  RoomDetailSnapshotSchema,
  RoomPinsResponseSchema,
  TeamRoomResponseSchema,
  type Exchange,
  type Job,
  type RoomPin,
  type Room,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'
import { reduceMessages, type MessagePageData } from '../../routes/chat/queries.ts'

/**
 * The read-model fields 11.2a adds to a job. They are optional here because this branch's contract predates that
 * change; when the server sends them the room shows unread counts and active agents without a second request.
 */
export type JobRead = Job & {
  unread?: number
  activeAgents?: string[]
  summary?: string | null
  lastMessageAt?: string | null
  messageCount?: number
}

export function readJobs(raw: unknown): JobRead[] {
  const base = JobsResponseSchema.parse(raw)
  const items = (raw as { items?: unknown } | null)?.items
  if (items === undefined) return base.items
  if (!Array.isArray(items)) throw new Error('Jobs items must be an array')
  return items.map((item) => {
    const job = JobSchema.parse(item)
    const extra = item as {
      unread?: unknown
      activeAgents?: unknown
      summary?: unknown
      lastMessageAt?: unknown
      messageCount?: unknown
    }
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
    const activeAgents = Array.isArray(extra.activeAgents)
      ? extra.activeAgents.filter((id): id is string => typeof id === 'string')
      : undefined
    return {
      ...job,
      ...(count(extra.unread) === undefined ? {} : { unread: count(extra.unread) }),
      ...(activeAgents === undefined ? {} : { activeAgents }),
      ...(typeof extra.summary === 'string' || extra.summary === null
        ? { summary: extra.summary }
        : {}),
      ...(typeof extra.lastMessageAt === 'string' || extra.lastMessageAt === null
        ? { lastMessageAt: extra.lastMessageAt }
        : {}),
      ...(count(extra.messageCount) === undefined
        ? {}
        : { messageCount: count(extra.messageCount) }),
    }
  })
}

/**
 * The always-on team room. `?room=` opens a room directly for the shell's own tests; without it the contract's
 * `GET /api/team-room` names the room (404 `not_ready` until the agents are known, which the room shows as a state).
 */
export function teamRoomQuery(roomIdOverride: string | null) {
  return defineStreamQuery<Room | null>({
    key: ['bold', 'team-room', roomIdOverride],
    async fetch(signal) {
      if (roomIdOverride !== null) {
        const snapshot = RoomDetailSnapshotSchema.parse(
          await apiFetch(`rooms/${encodeURIComponent(roomIdOverride)}`, { signal }),
        )
        return { asOfSeq: snapshot.asOfSeq, data: snapshot.room }
      }
      const snapshot = TeamRoomResponseSchema.parse(await apiFetch('team-room', { signal }))
      return { asOfSeq: snapshot.asOfSeq, data: snapshot.room }
    },
    types: ['room.upserted', 'room.deleted'],
    reduce(data, event) {
      if (event.type === 'room.deleted') return data?.id === event.data.id ? null : data
      if (event.type !== 'room.upserted') return data
      if (roomIdOverride !== null) return event.data.id === roomIdOverride ? event.data : data
      if (event.data.role === 'team') return event.data
      return data?.id === event.data.id ? event.data : data
    },
  })
}

/**
 * Every job's messages for the room's All view. The contract's message read is job-scoped (a room's default job when
 * no job is asked for), so the room reads each job and folds them together; the stream then keeps the folded list live.
 */
export function roomMessagesQuery(roomId: string, jobIds: string[], defaultJobId: string | null) {
  const ids = [...jobIds].sort()
  return defineStreamQuery<MessagePageData>({
    key: ['bold', 'room-messages', roomId, ids],
    async fetch(signal) {
      const pages = await Promise.all(
        ids.map(async (jobId) => {
          const params = new URLSearchParams({ limit: '50', jobId })
          return MessagePageSchema.parse(
            await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`, { signal }),
          )
        }),
      )
      return {
        asOfSeq: pages.reduce((max, page) => Math.max(max, page.asOfSeq), 0),
        data: {
          items: pages.flatMap((page) => page.items),
          nextCursor: null,
          typing: {},
          jobId: null,
        },
      }
    },
    types: [
      'message.created',
      'message.delta',
      'message.completed',
      'message.deleted',
      'message.updated',
      'message.progressed',
      'typing',
      'lane.upserted',
    ],
    reduce(data, event) {
      // A created message without a job belongs to the room's default thread; keep it visible in All.
      if (event.type === 'message.created' && event.data.jobId == null && defaultJobId !== null)
        return reduceMessages(
          data,
          { ...event, data: { ...event.data, jobId: defaultJobId } },
          roomId,
          true,
        )
      return reduceMessages(data, event, roomId, true)
    },
  })
}

export type RoomPinsState = { items: RoomPin[]; revision: number }

/** The room's pins (at most ten decisions) plus a revision bumped by `room.pins.changed` so the room can refetch. */
export function roomPinsQuery(roomId: string) {
  return defineStreamQuery<RoomPinsState>({
    key: ['bold', 'room-pins', roomId],
    async fetch(signal) {
      const response = RoomPinsResponseSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/pins`, { signal }),
      )
      return { asOfSeq: 0, data: { items: response.items, revision: 0 } }
    },
    types: ['room.pins.changed'],
    reduce(data, event) {
      return event.type === 'room.pins.changed' && event.data.roomId === roomId
        ? { ...data, revision: data.revision + 1 }
        : data
    },
  })
}

export async function setRoomPin(roomId: string, messageId: string, pinned: boolean) {
  await apiFetch(`rooms/${encodeURIComponent(roomId)}/pins/${encodeURIComponent(messageId)}`, {
    method: pinned ? 'POST' : 'DELETE',
  })
}

export function roomJobsQuery(roomId: string) {
  return defineStreamQuery<JobRead[]>({
    key: ['bold', 'jobs', roomId],
    async fetch(signal) {
      const raw: unknown = await apiFetch(`rooms/${encodeURIComponent(roomId)}/jobs`, { signal })
      const response = JobsResponseSchema.parse(raw)
      return { asOfSeq: response.asOfSeq, data: readJobs(raw) }
    },
    types: ['job.upserted'],
    reduce(data, event) {
      if (event.type !== 'job.upserted' || event.data.roomId !== roomId) return data
      const previous = data.find((job) => job.id === event.data.id)
      const next = {
        ...event.data,
        // Stream events carry the contract's job; keep the optional read-model fields from the snapshot.
        ...(previous?.unread === undefined ? {} : { unread: previous.unread }),
        ...(previous?.activeAgents === undefined ? {} : { activeAgents: previous.activeAgents }),
        ...(previous?.summary === undefined ? {} : { summary: previous.summary }),
        ...(previous?.lastMessageAt === undefined ? {} : { lastMessageAt: previous.lastMessageAt }),
        ...(previous?.messageCount === undefined ? {} : { messageCount: previous.messageCount }),
      } satisfies JobRead
      return [...data.filter((job) => job.id !== next.id), next].sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt),
      )
    },
  })
}

export function jobExchangesQuery(jobId: string) {
  return defineStreamQuery<Exchange[]>({
    key: ['bold', 'exchanges', jobId],
    async fetch(signal) {
      const response = ExchangesResponseSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(jobId)}/exchanges`, { signal }),
      )
      return { asOfSeq: response.asOfSeq, data: response.items }
    },
    types: ['exchange.upserted'],
    reduce(data, event) {
      if (event.type !== 'exchange.upserted' || event.data.jobId !== jobId) return data
      const exchange = ExchangeSchema.parse(event.data)
      return [...data.filter((item) => item.id !== exchange.id), exchange].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
    },
  })
}

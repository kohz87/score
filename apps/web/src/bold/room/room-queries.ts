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

/** The job read model as it now ships: `job.upserted` carries every field the tabs need. */
export type JobRead = Job

export function readJobs(raw: unknown): JobRead[] {
  return JobsResponseSchema.parse(raw).items
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
 * One job's message page. The room opens a page per job that is on screen (the selected tab, and in All the jobs
 * already read or opened); a job with unread messages keeps its badge until its own tab reads it. `before` pages
 * backwards through the same job, so "Load earlier" and a search target never fake a single 50-message history.
 */
export function roomMessagesQuery(
  roomId: string,
  jobId: string | null,
  before: string | null = null,
  defaultJobId: string | null = null,
) {
  return defineStreamQuery<MessagePageData>({
    key: ['bold', 'room-messages', roomId, jobId, before],
    async fetch(signal) {
      const params = new URLSearchParams({ limit: '50' })
      if (jobId !== null) params.set('jobId', jobId)
      if (before !== null) params.set('before', before)
      const page = MessagePageSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`, { signal }),
      )
      return { asOfSeq: page.asOfSeq, data: { ...page, typing: {} } }
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
      // A created message without a job belongs to the room's default thread; keep it visible where that thread is.
      if (
        event.type === 'message.created' &&
        event.data.jobId == null &&
        defaultJobId !== null &&
        (jobId === null || jobId === defaultJobId)
      )
        return reduceMessages(
          data,
          { ...event, data: { ...event.data, jobId: defaultJobId } },
          roomId,
          before === null,
        )
      return reduceMessages(data, event, roomId, before === null)
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
      // `job.upserted` carries the whole read model. Keeping the previous snapshot's unread/active fields would
      // leave a badge stuck after the server marks the job read.
      const next = JobSchema.parse(event.data)
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

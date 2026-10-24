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
  type Message,
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

/** The team-room read also carries the jobs that make the room switcher's "N jobs" honest. */
export interface TeamRoomRead {
  room: Room
  jobs: JobRead[]
}

function withJob(jobs: JobRead[], job: Job): JobRead[] {
  return [...jobs.filter((item) => item.id !== job.id), job].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt),
  )
}

/**
 * The always-on team room. `?room=` opens a room directly for the shell's own tests; without it the contract's
 * `GET /api/team-room` names the room (404 `not_ready` until the agents are known, which the room shows as a state).
 */
export function teamRoomQuery(roomIdOverride: string | null) {
  return defineStreamQuery<TeamRoomRead | null>({
    key: ['bold', 'team-room', roomIdOverride],
    async fetch(signal) {
      if (roomIdOverride !== null) {
        const snapshot = RoomDetailSnapshotSchema.parse(
          await apiFetch(`rooms/${encodeURIComponent(roomIdOverride)}`, { signal }),
        )
        return { asOfSeq: snapshot.asOfSeq, data: { room: snapshot.room, jobs: [] } }
      }
      const snapshot = TeamRoomResponseSchema.parse(await apiFetch('team-room', { signal }))
      return { asOfSeq: snapshot.asOfSeq, data: { room: snapshot.room, jobs: snapshot.jobs } }
    },
    types: ['room.upserted', 'room.deleted', 'job.upserted'],
    reduce(data, event) {
      if (event.type === 'room.deleted') return data?.room.id === event.data.id ? null : data
      if (event.type === 'job.upserted') {
        if (roomIdOverride !== null || !data || event.data.roomId !== data.room.id) return data
        return { ...data, jobs: withJob(data.jobs, JobSchema.parse(event.data)) }
      }
      if (event.type !== 'room.upserted' || !data) return data
      if (roomIdOverride !== null)
        return event.data.id === roomIdOverride ? { ...data, room: event.data } : data
      if (event.data.role === 'team') return { ...data, room: event.data }
      return data.room.id === event.data.id ? { ...data, room: event.data } : data
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

export type MessageSeekData = MessagePageData & { found: boolean }

/**
 * A search target (`?message=`) may be older than the first page. Walk backwards through the job's history in one
 * fetch until it appears (or the history ends), so seeking needs no state update from an effect. The cap keeps a bad
 * cursor chain from reading forever.
 */
export function roomSeekQuery(roomId: string, jobId: string | null, seek: string) {
  return defineStreamQuery<MessageSeekData>({
    key: ['bold', 'room-messages-seek', roomId, jobId, seek],
    async fetch(signal) {
      const items = new Map<string, Message>()
      const cursors = new Set<string>()
      let before: string | null = null
      let asOfSeq = 0
      let pageJobId = jobId
      let found = false
      for (let page = 0; page < 40; page += 1) {
        const params = new URLSearchParams({ limit: '50' })
        if (jobId !== null) params.set('jobId', jobId)
        if (before !== null) params.set('before', before)
        const snapshot = MessagePageSchema.parse(
          await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`, { signal }),
        )
        asOfSeq = Math.max(asOfSeq, snapshot.asOfSeq)
        pageJobId = snapshot.jobId ?? pageJobId
        for (const message of snapshot.items) items.set(message.id, message)
        if (items.has(seek)) {
          found = true
          break
        }
        const next = snapshot.nextCursor
        if (!next || cursors.has(next)) break
        cursors.add(next)
        before = next
      }
      return {
        asOfSeq,
        data: {
          asOfSeq,
          items: [...items.values()].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          ),
          nextCursor: null,
          jobId: pageJobId,
          typing: {},
          found,
        },
      }
    },
    // The seek is a one-off history read; the room's regular page stays the live one.
    types: [],
    reduce: (data) => data,
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

export function roomJobsQuery(roomId: string | null) {
  return defineStreamQuery<JobRead[]>({
    key: ['bold', 'jobs', roomId],
    async fetch(signal) {
      // The room is still resolving: the jobs read starts as soon as its id is known.
      if (roomId === null) return { asOfSeq: 0, data: [] }
      const raw: unknown = await apiFetch(`rooms/${encodeURIComponent(roomId)}/jobs`, { signal })
      const response = JobsResponseSchema.parse(raw)
      return { asOfSeq: response.asOfSeq, data: readJobs(raw) }
    },
    types: ['job.upserted'],
    reduce(data, event) {
      if (event.type !== 'job.upserted' || roomId === null || event.data.roomId !== roomId)
        return data
      // `job.upserted` carries the whole read model. Keeping the previous snapshot's unread/active fields would
      // leave a badge stuck after the server marks the job read.
      return withJob(data, JobSchema.parse(event.data))
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

/** The paused exchanges of several jobs in one read, so the pinned strip can show one card across the room. */
export function roomExchangesQuery(jobIds: string[]) {
  const ids = [...new Set(jobIds)].sort()
  return defineStreamQuery<Exchange[]>({
    key: ['bold', 'exchanges', 'room', ...ids],
    async fetch(signal) {
      const responses = await Promise.all(
        ids.map(async (jobId) =>
          ExchangesResponseSchema.parse(
            await apiFetch(`jobs/${encodeURIComponent(jobId)}/exchanges`, { signal }),
          ),
        ),
      )
      return {
        asOfSeq: responses.reduce((highest, response) => Math.max(highest, response.asOfSeq), 0),
        data: responses
          .flatMap((response) => response.items)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      }
    },
    types: ['exchange.upserted'],
    reduce(data, event) {
      if (event.type !== 'exchange.upserted' || !ids.includes(event.data.jobId)) return data
      const exchange = ExchangeSchema.parse(event.data)
      return [...data.filter((item) => item.id !== exchange.id), exchange].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      )
    },
  })
}

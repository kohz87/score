import {
  ExchangeSchema,
  ExchangesResponseSchema,
  JobSchema,
  JobsResponseSchema,
  parseStreamFrame,
  RoomDetailSnapshotSchema,
  RoomSchema,
  RoomsSnapshotSchema,
  type Exchange,
  type Job,
  type Room,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { defineStreamQuery } from '../../data/resync.ts'

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
 * The hidden team room has no list route in this branch's contract. It is still announced by `room.upserted` on the
 * stream, so replay the retained events from the start once and take the room from there. The read stops as soon as
 * the event at the hello's head has been seen (or earlier, when the room is found), so it never stays connected.
 */
async function discoverTeamRoom(signal: AbortSignal): Promise<Room | null> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch('/api/stream?since=0', {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok || !response.body) return null
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let head: number | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) return null
      buffer += decoder.decode(value, { stream: true })
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        const parsed = parseStreamFrame(data)
        if (parsed.kind === 'control' && parsed.frame.type === 'stream.hello') {
          head = parsed.frame.data.headSeq
        } else if (parsed.kind === 'event') {
          if (parsed.event.type === 'room.upserted' && parsed.event.data.role === 'team') {
            return RoomSchema.parse(parsed.event.data)
          }
          if (head !== null && parsed.event.seq >= head) return null
        } else if (parsed.kind === 'control' && parsed.frame.type === 'stream.reset') {
          return null
        }
      }
    }
  } catch {
    return null
  } finally {
    signal.removeEventListener('abort', abort)
    controller.abort()
  }
}

/**
 * The always-on team room. `?room=` opens a room directly for the current shell and e2e; without it the list is
 * checked (newer servers may include it) and then the stream's retained room events are replayed once. A missing room
 * is a normal empty result, not an error.
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
      const snapshot = RoomsSnapshotSchema.parse(await apiFetch('rooms', { signal }))
      const listed = [...snapshot.rooms, ...snapshot.directs].find((room) => room.role === 'team')
      return {
        asOfSeq: snapshot.asOfSeq,
        data: listed ?? (signal ? await discoverTeamRoom(signal) : null),
      }
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
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt),
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

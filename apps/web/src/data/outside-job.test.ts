import type { Job, Message, OutsideSession } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import {
  bringOutsideSessionIntoJob,
  newBringOutsideSessionAttempt,
  previewOutsideSession,
  sortImportedMessages,
} from './outside-job.ts'

const session: OutsideSession = {
  id: 'ext-telegram-1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch checklist',
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: 3,
  busy: false,
  roomId: null,
}

const job: Job = {
  id: 'job-launch',
  roomId: 'team-room',
  title: 'Plan the launch checklist',
  state: 'open',
  holderAgentId: 'lead',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  spendCapUsd: null,
  recipe: null,
  unread: 0,
  activeAgents: [],
  lastMessageAt: null,
  messageCount: 0,
  summary: null,
  source: null,
  reportBack: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
}

function message(id: string, text: string, minute: number): Message {
  return {
    id,
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'agent', agentId: 'lead' },
    to: [],
    parts: text
      ? [{ kind: 'text', text }]
      : [{ kind: 'notice', code: 'no_lead', text: 'No lead yet.' }],
    createdAt: `2026-10-23T09:${String(minute).padStart(2, '0')}:00.000Z`,
    streaming: false,
    refs: [],
  }
}

interface Call {
  url: string
  method: string
  body: unknown
  headers: Headers
}

function record(calls: Call[], input: RequestInfo | URL, init?: RequestInit) {
  calls.push({
    url: String(input),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers: new Headers(init?.headers),
  })
}

afterEach(() => vi.unstubAllGlobals())

test('previews a session as the imported room’s text messages', async () => {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(calls, input, init)
      const url = String(input)
      if (url === '/api/outside-sessions/import')
        return Response.json({ roomId: 'room-imported', imported: 3 })
      if (url.startsWith('/api/rooms/room-imported/messages?'))
        return Response.json({
          asOfSeq: 1,
          items: [message('message-1', '', 1), message('message-2', 'Ready.', 2)],
          nextCursor: null,
          jobId: 'job-imported',
        })
      return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 })
    }),
  )

  const preview = await previewOutsideSession(session)

  expect(preview).toEqual({
    roomId: 'room-imported',
    messages: [message('message-2', 'Ready.', 2)],
  })
  expect(calls.map((call) => call.url)).toEqual([
    '/api/outside-sessions/import',
    '/api/rooms/room-imported/messages?limit=100',
  ])
})

test('brings a session in by importing it, creating a team job and sharing each text in order', async () => {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    record(calls, input, init)
    const url = String(input)
    if (url === '/api/outside-sessions/import')
      return Response.json({ roomId: 'room-imported', imported: 3 })
    if (url.startsWith('/api/rooms/room-imported/messages?')) {
      const older = new URL(url, 'http://x').searchParams.get('before')
      return older
        ? Response.json({
            asOfSeq: 1,
            items: [message('message-0', 'Outline the launch.', 1)],
            nextCursor: null,
            jobId: 'job-imported',
          })
        : Response.json({
            asOfSeq: 1,
            items: [message('message-2', 'Review the docs.', 3), message('message-1', '', 2)],
            nextCursor: 'older-page',
            jobId: 'job-imported',
          })
    }
    if (url === '/api/rooms/team-room/jobs' && init?.method === 'POST') return Response.json(job)
    if (url.startsWith('/api/messages/') && url.endsWith('/share'))
      return Response.json({ messageId: `shared-${calls.length}` }, { status: 201 })
    return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)

  const result = await bringOutsideSessionIntoJob(session, 'team-room')

  expect(result).toEqual({ job, importedRoomId: 'room-imported', attached: 2 })
  expect(calls.find((call) => call.url === '/api/outside-sessions/import')?.body).toEqual({
    agentId: 'lead',
    sessionId: 'ext-telegram-1',
  })
  const pageCalls = calls.filter((call) => call.url.includes('/rooms/room-imported/messages?'))
  expect(pageCalls).toHaveLength(2)
  expect(pageCalls[0]!.url).toContain('limit=100')
  expect(pageCalls[1]!.url).toContain('before=older-page')
  const created = calls.find((call) => call.url === '/api/rooms/team-room/jobs')
  expect(created?.body).toEqual({ title: 'Plan the launch checklist' })
  const key = created?.headers.get('Idempotency-Key')
  expect(key).toBeTruthy()
  const shares = calls.filter((call) => call.url.endsWith('/share'))
  expect(shares.map((call) => [call.url, call.body])).toEqual([
    ['/api/messages/message-0/share', { jobId: 'job-launch' }],
    ['/api/messages/message-2/share', { jobId: 'job-launch' }],
  ])
  expect(shares.every((call) => Boolean(call.headers.get('Idempotency-Key')))).toBe(true)
  expect(new Set(shares.map((call) => call.headers.get('Idempotency-Key'))).size).toBe(
    shares.length,
  )
  expect(shares.every((call) => call.headers.get('Idempotency-Key') !== key)).toBe(true)
})

test('a 500 is not replayed: the retry sends a new key and succeeds', async () => {
  const calls: Call[] = []
  const receipts = new Map<string, number>()
  let failSecondShare = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(calls, input, init)
      const url = String(input)
      const route = url.split('?', 1)[0]!
      const key = new Headers(init?.headers).get('Idempotency-Key')
      if (key) {
        const stored = receipts.get(`${key} ${route}`)
        if (stored !== undefined)
          return Response.json(
            { error: { code: 'replayed', message: 'Stored answer.' } },
            { status: stored },
          )
      }
      if (url === '/api/outside-sessions/import')
        return Response.json({ roomId: 'room-imported', imported: 2 })
      if (url.startsWith('/api/rooms/room-imported/messages?'))
        return Response.json({
          asOfSeq: 1,
          items: [message('message-1', 'First.', 1), message('message-2', 'Second.', 2)],
          nextCursor: null,
          jobId: 'job-imported',
        })
      if (url === '/api/rooms/team-room/jobs' && init?.method === 'POST') return Response.json(job)
      if (url === '/api/messages/message-1/share') {
        if (key) receipts.set(`${key} ${route}`, 201)
        return Response.json({ messageId: 'shared-1' }, { status: 201 })
      }
      if (url === '/api/messages/message-2/share') {
        if (failSecondShare) {
          failSecondShare = false
          if (key) receipts.set(`${key} ${route}`, 500)
          return Response.json({ error: { code: 'boom', message: 'nope' } }, { status: 500 })
        }
        if (key) receipts.set(`${key} ${route}`, 201)
        return Response.json({ messageId: 'shared-2' }, { status: 201 })
      }
      return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 })
    }),
  )

  const attempt = newBringOutsideSessionAttempt()
  await expect(bringOutsideSessionIntoJob(session, 'team-room', attempt)).rejects.toThrow()

  const result = await bringOutsideSessionIntoJob(session, 'team-room', attempt)

  expect(result).toEqual({ job, importedRoomId: 'room-imported', attached: 1 })
  const writes = calls.filter((call) => call.method === 'POST').map((call) => call.url)
  expect(writes).toEqual([
    '/api/outside-sessions/import',
    '/api/rooms/team-room/jobs',
    '/api/messages/message-1/share',
    '/api/messages/message-2/share',
    '/api/messages/message-2/share',
  ])
  expect(calls.filter((call) => call.url === '/api/rooms/team-room/jobs')).toHaveLength(1)
  expect(calls.filter((call) => call.url === '/api/outside-sessions/import')).toHaveLength(1)
  const shares = calls.filter((call) => call.url.endsWith('/share'))
  const firstKey = shares
    .find((call) => call.url.endsWith('message-1/share'))
    ?.headers.get('Idempotency-Key')
  const failedKey = shares
    .find((call) => call.url.endsWith('message-2/share'))
    ?.headers.get('Idempotency-Key')
  const retryKey = shares.at(-1)?.headers.get('Idempotency-Key')
  expect(firstKey).toBeTruthy()
  expect(failedKey).toBeTruthy()
  expect(failedKey).not.toBe(firstKey)
  expect(retryKey).toBeTruthy()
  expect(retryKey).not.toBe(failedKey)
})

test('a network failure keeps that call’s key for its retry', async () => {
  const calls: Call[] = []
  let drop = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(calls, input, init)
      const url = String(input)
      if (url === '/api/outside-sessions/import')
        return Response.json({ roomId: 'room-imported', imported: 1 })
      if (url.startsWith('/api/rooms/room-imported/messages?'))
        return Response.json({
          asOfSeq: 1,
          items: [message('message-1', 'Only one.', 1)],
          nextCursor: null,
          jobId: 'job-imported',
        })
      if (url === '/api/rooms/team-room/jobs' && init?.method === 'POST') return Response.json(job)
      if (url === '/api/messages/message-1/share') {
        if (drop) {
          drop = false
          throw new TypeError('The connection dropped.')
        }
        return Response.json({ messageId: 'shared-1' }, { status: 201 })
      }
      return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 })
    }),
  )

  const attempt = newBringOutsideSessionAttempt()
  await expect(bringOutsideSessionIntoJob(session, 'team-room', attempt)).rejects.toThrow(
    'connection dropped',
  )
  await bringOutsideSessionIntoJob(session, 'team-room', attempt)

  const shares = calls.filter((call) => call.url.endsWith('/share'))
  expect(shares).toHaveLength(2)
  expect(shares[0]!.headers.get('Idempotency-Key')).toBe(shares[1]!.headers.get('Idempotency-Key'))
  expect(calls.filter((call) => call.url === '/api/rooms/team-room/jobs')).toHaveLength(1)
})

test('imported messages with equal times are ordered by their numeric import suffix', () => {
  const at = '2026-10-23T09:00:00.000Z'
  const ordered = sortImportedMessages([
    { ...message('import:room:10', 'Ten.', 1), createdAt: at },
    { ...message('import:room:2', 'Two.', 1), createdAt: at },
    { ...message('import:room:1', 'One.', 1), createdAt: at },
  ])

  expect(ordered.map((item) => item.id)).toEqual([
    'import:room:1',
    'import:room:2',
    'import:room:10',
  ])
})

test('falls back to the source label when the session has no title', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/outside-sessions/import')
      return Response.json({ roomId: 'room-imported', imported: 0 })
    if (url.includes('/rooms/room-imported/messages?'))
      return Response.json({ asOfSeq: 1, items: [], nextCursor: null, jobId: 'job-imported' })
    if (url === '/api/rooms/team-room/jobs' && init?.method === 'POST')
      return Response.json({ ...job, title: 'From Telegram' })
    return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)

  await bringOutsideSessionIntoJob({ ...session, title: '' }, 'team-room')

  const created = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === '/api/rooms/team-room/jobs' && init?.method === 'POST',
  )
  expect(JSON.parse(String(created?.[1]?.body))).toEqual({ title: 'From Telegram' })
})

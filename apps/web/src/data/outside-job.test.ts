import type { Job, Message, OutsideSession } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { bringOutsideSessionIntoJob } from './outside-job.ts'

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

afterEach(() => vi.unstubAllGlobals())

test('brings a session in by importing it, creating a team job and sharing each text in order', async () => {
  const calls: { url: string; method: string; body: unknown; headers: Headers }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    })
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
  expect(created?.headers.get('Idempotency-Key')).toBeTruthy()
  expect(
    calls.filter((call) => call.url.endsWith('/share')).map((call) => [call.url, call.body]),
  ).toEqual([
    ['/api/messages/message-0/share', { jobId: 'job-launch' }],
    ['/api/messages/message-2/share', { jobId: 'job-launch' }],
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

import { expect, type Page, type Route } from '@playwright/test'
import { mockBoldRoom, type RoomRequest } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

type Json = Record<string, unknown>

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

const team = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: ['builder'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

const older = {
  id: 'room-old',
  name: '#activity-feed',
  kind: 'room',
  leadAgentId: null,
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'room',
  routing: 'mentions',
}

function job(id: string, roomId: string, title: string, extra: Json = {}): Json {
  return {
    id,
    roomId,
    title,
    state: 'working',
    holderAgentId: 'builder',
    isDefault: false,
    exchangeBudget: 8,
    jobTurnLimit: 40,
    unread: 0,
    activeAgents: [],
    lastMessageAt: null,
    messageCount: 0,
    summary: null,
    source: null,
    reportBack: null,
    spendCapUsd: null,
    recipe: null,
    createdAt: at(0),
    updatedAt: at(15),
    ...extra,
  }
}

const defaultTeamJob = job('job-default', team.id, team.name, {
  isDefault: true,
  holderAgentId: 'lead',
})
const activityJob = job('job-activity', team.id, 'Activity feed', {
  unread: 2,
  lastMessageAt: at(7),
  messageCount: 2,
})
const notesJob = job('job-notes', team.id, 'Release notes 2.4', {
  state: 'waiting_on_you',
  holderAgentId: 'lead',
  unread: 3,
})
const oldJob = job('job-old', older.id, older.name, { isDefault: true, holderAgentId: null })

const oldMessage = {
  id: 'message-old',
  roomId: older.id,
  jobId: oldJob.id,
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [{ kind: 'text', text: 'The feed is live. Ask builder for the cursor work.' }],
  createdAt: at(3),
  streaming: false,
  refs: [],
}

const outside = {
  id: 'ext-telegram-1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch checklist',
  startedAt: '2026-10-23T08:00:00.000Z',
  messageCount: 4,
  busy: false,
  roomId: null,
}

const importedMessages = [
  {
    id: 'import:1',
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'agent', agentId: 'lead' },
    to: [],
    parts: [{ kind: 'text', text: 'Outline the launch checklist.' }],
    createdAt: '2026-10-23T08:00:00.000Z',
    streaming: false,
    refs: [],
  },
  {
    id: 'import:2',
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'agent', agentId: 'lead' },
    to: [],
    parts: [{ kind: 'text', text: 'Freeze the release branch, test, then announce.' }],
    createdAt: '2026-10-23T08:01:00.000Z',
    streaming: false,
    refs: [],
  },
]

function response(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

/** The 11.4d room data on top of the stable bold-room fixture: an older room, Elsewhere and the menu endpoints. */
export async function mockRoomMenus(page: Page, options: { failShare?: number } = {}) {
  const requests: RoomRequest[] = []
  let createdJob: Json | null = null
  let roomDeleted = false
  let shareCalls = 0
  let failedShare = false

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname
    let body: unknown
    if (request.postData()) {
      try {
        body = JSON.parse(request.postData() ?? '')
      } catch {
        body = request.postData()
      }
    }
    requests.push({ method, path, search: url.searchParams, body, headers: request.headers() })

    if (method === 'GET' && path === '/api/rooms')
      return response(route, {
        asOfSeq: 12,
        rooms: roomDeleted ? [] : [older],
        directs: [],
        projects: [],
      })
    if (method === 'GET' && path === '/api/outside-sessions')
      return response(route, { items: [outside], unavailable: [] })
    if (method === 'GET' && path === `/api/rooms/${older.id}`)
      return response(route, { asOfSeq: 12, room: older, filesInPlay: [], learned: [] })
    if (method === 'GET' && path === `/api/rooms/${older.id}/jobs`)
      return response(route, { asOfSeq: 12, items: [oldJob] })
    if (method === 'GET' && path === `/api/rooms/${older.id}/messages`)
      return response(route, {
        asOfSeq: 12,
        items: [oldMessage],
        nextCursor: null,
        jobId: oldJob.id,
      })
    if (method === 'POST' && path === `/api/rooms/${older.id}/messages`) {
      const payload = (typeof body === 'object' && body !== null ? body : {}) as Json
      return response(route, {
        message: {
          ...oldMessage,
          id: 'message-old-sent',
          author: { kind: 'you' },
          to: ['builder'],
          parts: [{ kind: 'text', text: String(payload.text ?? '') }],
          createdAt: at(20),
        },
        routedTo: ['builder'],
        command: null,
      })
    }
    if (method === 'GET' && path === `/api/rooms/${older.id}/pins`)
      return response(route, { items: [] })
    if (method === 'GET' && path === `/api/rooms/${older.id}/versions`)
      return response(route, { asOfSeq: 12, items: [] })
    if (method === 'GET' && path === `/api/rooms/${older.id}/delete-plan`)
      return response(route, {
        name: older.name,
        messages: 1,
        files: 0,
        runs: 0,
        briefs: 0,
        blocked: null,
      })
    if (method === 'DELETE' && path === `/api/rooms/${older.id}`) {
      roomDeleted = true
      return route.fulfill({ status: 204 })
    }
    if (method === 'GET' && path === `/api/rooms/${team.id}/jobs`)
      return response(route, {
        // A newer snapshot once the job exists, as the real server's sequence would be.
        asOfSeq: createdJob ? 13 : 12,
        items: [defaultTeamJob, activityJob, notesJob, ...(createdJob ? [createdJob] : [])],
      })
    if (method === 'POST' && path === `/api/rooms/${team.id}/jobs`) {
      const payload = (typeof body === 'object' && body !== null ? body : {}) as Json
      createdJob = job('job-brought', team.id, String(payload.title ?? 'From elsewhere'), {
        state: 'open',
        holderAgentId: 'lead',
      })
      return response(route, createdJob, 201)
    }
    if (method === 'GET' && path === '/api/rooms/room-imported/messages')
      return response(route, {
        asOfSeq: 12,
        items: importedMessages,
        nextCursor: null,
        jobId: 'job-imported',
      })
    if (method === 'POST' && path === '/api/outside-sessions/import')
      return response(route, { roomId: 'room-imported', imported: 2 })
    if (method === 'POST' && /^\/api\/messages\/import%3A\d+\/share$/.test(path)) {
      shareCalls += 1
      if (!failedShare && options.failShare === shareCalls) {
        failedShare = true
        return response(route, { error: { code: 'boom', message: 'Share failed.' } }, 500)
      }
      return response(route, { messageId: `shared-${path}` }, 201)
    }
    if (method === 'GET' && path.endsWith('/export.md'))
      return route.fulfill({
        status: 200,
        contentType: 'text/markdown; charset=utf-8',
        headers: { 'content-disposition': 'attachment; filename="room.md"' },
        body: '# Exported room\n\nThe room as Markdown.\n',
      })
    if (path.endsWith('/shares') && method === 'GET') return response(route, { items: [] })
    if (path.endsWith('/shares') && method === 'POST')
      return response(route, {
        id: 'share-menu',
        url: 'https://score.lan/s/ROOM-MENU',
        expiresAt: '2026-10-31T10:00:00.000Z',
      })
    if (method === 'GET' && path === '/api/shares') return response(route, { items: [] })
    return route.fallback()
  })

  return { requests }
}

export async function openMenuRoom(page: Page, options: { failShare?: number } = {}) {
  await pair(page)
  const base = await mockBoldRoom(page)
  const menu = await mockRoomMenus(page, options)
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
  return { ...base, ...menu }
}

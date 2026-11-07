import { expect, type Page, type Route } from '@playwright/test'
import {
  approval,
  at,
  commands,
  defaultExchange,
  deleted,
  jobs,
  messages,
  room,
  triggerSource,
  versionItems,
  versions,
} from './bold-room-fixture-data.ts'
import { openInfoSection } from './bold-chat-helpers.ts'
import { pair } from './pair.ts'

type Json = Record<string, unknown>

export interface RoomRequest {
  method: string
  path: string
  search: URLSearchParams
  body: unknown
  headers: Record<string, string>
}

export interface BoldRoomReply {
  body: unknown
  status?: number
}

export interface BoldRoomOptions {
  /** No named jobs and no messages: board 09. */
  empty?: boolean
  /** How long `/api/media` holds the upload before answering, so its progress is visible. */
  uploadDelay?: number
  /** Replace the paused review with another contract-valid pause (the seeded fake has no send-back fixture). */
  exchange?: Json
  /** Add a frozen one-to-one reply to the Activity feed job, as sharing one into the room does. */
  shared?: boolean
  /** Give the Activity feed job a trigger source, for the Started-by card. */
  source?: boolean
  /** Give the Activity feed job a trigger source and this report-back state. */
  reportBack?: Json | null
  /** Replace the approval list (an empty list isolates a run-safety card). */
  approvals?: Json[]
  /** Replace the room's exchanges, across the named jobs. */
  exchanges?: Json[]
  /** Replace the room's job list (a run-safety card needs a recipe-linked job). */
  jobs?: Json[]
  /** Answer reads the fixtures do not cover, before the defaults; `undefined` falls through. */
  handle?: (request: RoomRequest) => BoldRoomReply | undefined | Promise<BoldRoomReply | undefined>
}

function response(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function sentMessage(body: Json, index: number) {
  const requestedTo = Array.isArray(body.to) ? body.to : []
  return {
    id: `message-sent-${index}`,
    roomId: room.id,
    jobId: typeof body.jobId === 'string' ? body.jobId : 'job-default',
    author: { kind: 'you' },
    to: requestedTo,
    parts: [{ kind: 'text', text: String(body.text ?? '') }],
    createdAt: new Date().toISOString(),
    streaming: false,
    refs: [],
  }
}

/** Routes the bold room's reads and mutations to stable contract-shaped fixtures; every other API stays real. */
export async function mockBoldRoom(page: Page, options: BoldRoomOptions = {}) {
  const baseJobs = options.jobs ?? jobs
  const visibleJobs = (options.empty ? baseJobs.filter((item) => item.isDefault) : baseJobs).map(
    (item) =>
      (options.source || options.reportBack) && item.id === 'job-activity'
        ? { ...item, source: triggerSource, reportBack: options.reportBack ?? item.reportBack }
        : item,
  )
  const roomMessages: Record<string, Json[]> = { ...messages }
  if (options.shared)
    roomMessages['job-activity'] = [
      ...(roomMessages['job-activity'] ?? []),
      {
        id: 'message-shared',
        roomId: room.id,
        jobId: 'job-activity',
        author: { kind: 'you' },
        to: [],
        parts: [
          {
            kind: 'shared',
            from: {
              roomId: 'dm-builder',
              jobId: 'chat-builder',
              messageId: 'message-shared-source',
              agentId: 'builder',
              at: at(12),
            },
            text: 'The cursor is stable when the page reloads.',
          },
        ],
        createdAt: at(12),
        streaming: false,
        refs: [],
      },
    ]
  let exchanges = options.exchanges ?? [options.exchange ?? defaultExchange]
  let approvals = options.approvals ?? [approval]
  const pins = new Map([['message-pinned', 'Event cursors are (created_at, id).']])
  const requests: RoomRequest[] = []
  let sent = 0

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname
    let body: unknown = undefined
    if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && request.postData()) {
      try {
        body = JSON.parse(request.postData() ?? '')
      } catch {
        body = request.postData()
      }
    }
    requests.push({ method, path, search: url.searchParams, body, headers: request.headers() })

    const handled = await options.handle?.({
      method,
      path,
      search: url.searchParams,
      body,
      headers: request.headers(),
    })
    if (handled) return response(route, handled.body, handled.status)

    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (method === 'GET' && path === '/api/team-room')
      return response(route, {
        asOfSeq: 12,
        room,
        jobs: visibleJobs,
      })
    if (method === 'GET' && path === '/api/rooms/team-room/jobs')
      return response(route, { asOfSeq: 12, items: visibleJobs })
    if (
      method === 'GET' &&
      path === '/api/rooms/team-room/messages' &&
      url.searchParams.get('all') === '1'
    ) {
      // 3.22.0: one conversation of every topic, newest first, each message with its jobId; no job in the reply.
      const every = Object.values(roomMessages)
        .flat()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return response(route, {
        asOfSeq: 12,
        items: options.empty ? [] : every,
        nextCursor: null,
        jobId: null,
      })
    }
    if (method === 'GET' && path === '/api/rooms/team-room/messages') {
      const jobId = url.searchParams.get('jobId') ?? 'job-default'
      return response(route, {
        asOfSeq: 12,
        items: options.empty ? [] : (roomMessages[jobId] ?? []),
        nextCursor: null,
        jobId,
      })
    }
    if (method === 'GET' && path === '/api/rooms/team-room/pins')
      return response(route, {
        items: [...pins].map(([messageId, text]) => ({
          messageId,
          text,
          pinnedAt: at(2),
        })),
      })
    if (method === 'POST' && path.startsWith('/api/rooms/team-room/pins/')) {
      const messageId = decodeURIComponent(path.split('/').pop() ?? '')
      const message = Object.values(roomMessages)
        .flat()
        .find((item) => item.id === messageId)
      const part = Array.isArray(message?.parts) ? (message.parts as Json[])[0] : undefined
      pins.set(messageId, typeof part?.text === 'string' ? part.text : 'Pinned message')
      return route.fulfill({ status: 204 })
    }
    if (method === 'DELETE' && path.startsWith('/api/rooms/team-room/pins/')) {
      pins.delete(decodeURIComponent(path.split('/').pop() ?? ''))
      return route.fulfill({ status: 204 })
    }
    if (method === 'GET' && path === '/api/rooms/team-room/versions')
      return response(route, { asOfSeq: 12, items: options.empty ? [] : versions })
    if (method === 'GET' && path.startsWith('/api/rooms/team-room/versions/')) {
      const anchorId = decodeURIComponent(path.split('/').pop() ?? '')
      const version = versions.find((item) => item.anchorId === anchorId)
      return response(route, { version, items: versionItems[anchorId] ?? [] })
    }
    if (path.startsWith('/api/rooms/team-room/messages/')) {
      const rest = path.slice('/api/rooms/team-room/messages/'.length)
      if (method === 'GET' && rest.endsWith('/rewind-plan'))
        return response(route, {
          hiddenCount: 2,
          agents: [{ agentId: 'builder', turns: 1, cannot: null }],
          blocked: null,
        })
      if (method === 'POST' && rest.endsWith('/rewind'))
        return response(route, {
          version: {
            ...deleted,
            id: `version-${rest.split('/')[0]}`,
            anchorId: rest.split('/')[0],
          },
          rewound: [{ agentId: 'builder', turnsUndone: 1 }],
          skipped: [],
        })
      if (method === 'GET') return response(route, { ok: true })
    }
    if (method === 'GET' && /^\/api\/jobs\/[^/]+\/exchanges$/.test(path)) {
      const jobId = decodeURIComponent(path.split('/')[3] ?? '')
      return response(route, {
        asOfSeq: 12,
        items: jobId === 'job-notes' ? exchanges : [],
      })
    }
    if (method === 'GET' && path === '/api/approvals')
      return response(route, {
        asOfSeq: 12,
        items: options.empty ? [] : approvals,
        nextCursor: null,
      })
    if (method === 'POST' && path === `/api/approvals/${approval.id}/decision`) {
      const choice =
        typeof body === 'object' && body !== null
          ? (body as { choice?: unknown }).choice
          : undefined
      const decided = {
        ...approval,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice, by: 'you', at: at(12) },
        delivery: 'applied',
      }
      approvals = approvals.map((item) => (item.id === approval.id ? decided : item))
      return response(route, decided)
    }
    if (method === 'POST' && /^\/api\/exchanges\/[^/]+\/decision$/.test(path)) {
      const exchangeId = decodeURIComponent(path.split('/')[3] ?? '')
      exchanges = exchanges.map((item) =>
        item.id === exchangeId ? { ...item, state: 'live', pause: null, updatedAt: at(20) } : item,
      )
      return response(route, { ok: true })
    }
    if (method === 'GET' && path === '/api/commands') return response(route, commands)
    if (method === 'POST' && path === '/api/rooms/team-room/messages') {
      sent += 1
      const payload = (typeof body === 'object' && body !== null ? body : {}) as Json
      const message = sentMessage(payload, sent)
      const command =
        typeof payload.text === 'string' && payload.text.startsWith('/assign ')
          ? { kind: 'assign', taskId: 'task-room-1', taskKey: 'OPS-1' }
          : null
      return response(route, {
        message,
        routedTo: message.to,
        command,
      })
    }
    if (method === 'POST' && path === '/api/media') {
      if (options.uploadDelay)
        await new Promise((resolve) => setTimeout(resolve, options.uploadDelay))
      return response(route, {
        mediaId: 'media-notes',
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 19,
      })
    }
    if (method === 'PUT' && path.startsWith('/api/knowledge/files/'))
      return response(route, {
        path: decodeURIComponent(path.slice('/api/knowledge/files/'.length)),
        kind: 'note',
        replaced: false,
        history: 'committed',
      })
    return route.fallback()
  })

  return { requests, pins }
}

export async function openBoldRoom(page: Page, options: BoldRoomOptions = {}) {
  return openBoldRoomWith(page, options)
}

/** `before` runs after the room's routes are in place and before the page opens (the theme routes of 11.9d). */
export async function openBoldRoomWith(
  page: Page,
  options: BoldRoomOptions = {},
  before?: (page: Page) => Promise<unknown>,
) {
  await pair(page)
  const state = await mockBoldRoom(page, options)
  await before?.(page)
  await page.goto('/b?open=1')
  await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
  return state
}

/** Opens the chat's Info on its Topics: a desktop's side panel already shows it, a phone's sheet opens from `?jobs=1`. */
export async function openTopicsOnPhone(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) > 860) return
  // 3.24.0: the All topics screen is gone; an old `?jobs=1` link opens the chat with Info on Past jobs (3.28.0).
  const url = new URL(page.url())
  url.searchParams.set('jobs', '1')
  await page.goto(url.toString())
  await expect(page.getByRole('heading', { name: 'Past jobs' })).toBeVisible()
}

/** Makes a topic current: the phone picks it in Info › Topics (the sheet closes), the desktop in its side panel. */
export async function openBoldJob(page: Page, title: RegExp) {
  const phone = (page.viewportSize()?.width ?? 1440) <= 860
  if (phone) await openTopicsOnPhone(page)
  // 3.28.0: finished jobs are under Past jobs, and a legacy room's active ones under Open jobs (only there). Both start
  // folded; a person opens each by its heading toggle (a `?jobs=1` landing already has Past jobs).
  await openInfoSection(page, 'Past jobs')
  if ((await page.getByRole('heading', { name: 'Open jobs' }).count()) > 0)
    await openInfoSection(page, 'Open jobs')
  // The retired job list named its rows "Title. State…"; a topic row's title element holds only the title.
  const rowTitle = new RegExp(title.source.replace(/\\\.(\.\*)?$/, '$'), title.flags)
  await page
    .locator('.bold-chat-topics a')
    .filter({ has: page.locator('.bold-chat-topic-title').filter({ hasText: rowTitle }) })
    .first()
    .click()
  // 3.22.0: no job tabs on a desktop; the pick makes the topic current (the conversation scrolls to its divider).
  if (phone) await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
}

/**
 * 3.24.0: needs-you cards sit in the conversation, so every topic's cards are in the one conversation on a phone as on a
 * desktop; nothing to open any more. Kept so specs read the same; it only checks the conversation is there.
 */
export async function showAllJobsOnPhone(page: Page) {
  await expect(page.locator('.bold-stream').first()).toBeAttached()
}

/**
 * Opens the list of older, imported and elsewhere chats: the room menu's "Older, imported and elsewhere chats…" on a
 * desktop and on a phone (3.24.0: the phone title switcher is gone).
 */
export async function openRoomPicker(page: Page) {
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: /Older, imported and elsewhere chats/ }).click()
  return page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
}

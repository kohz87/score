import { expect, type Page, type Route } from '@playwright/test'
import { pair } from './pair.ts'

type Json = Record<string, unknown>

export interface RoomRequest {
  method: string
  path: string
  search: URLSearchParams
  body: unknown
  headers: Record<string, string>
}

export interface BoldRoomOptions {
  /** No named jobs and no messages: board 09. */
  empty?: boolean
  /** How long `/api/media` holds the upload before answering, so its progress is visible. */
  uploadDelay?: number
  /** Replace the paused review with another contract-valid pause (the seeded fake has no send-back fixture). */
  exchange?: Json
}

const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

const room = {
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

function job(id: string, title: string, extra: Json = {}) {
  return {
    id,
    roomId: room.id,
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

const jobs = [
  job('job-default', 'Team room', {
    isDefault: true,
    holderAgentId: 'lead',
    lastMessageAt: at(2),
    messageCount: 1,
  }),
  job('job-activity', 'Activity feed', {
    unread: 2,
    holderAgentId: 'builder',
    lastMessageAt: at(7),
    messageCount: 5,
  }),
  job('job-notes', 'Release notes 2.4', {
    state: 'waiting_on_you',
    holderAgentId: 'lead',
    unread: 3,
    lastMessageAt: at(9),
    messageCount: 2,
  }),
  job('job-queue', 'Queue research', {
    state: 'done',
    holderAgentId: 'lead',
    lastMessageAt: at(10),
    messageCount: 1,
  }),
  job('job-closed', 'Old import', {
    state: 'closed',
    holderAgentId: 'designer',
    unread: 1,
    lastMessageAt: at(11),
    messageCount: 1,
  }),
]

function text(
  id: string,
  jobId: string,
  author: { kind: 'you' } | { kind: 'agent'; agentId: string },
  value: string,
  minute: number,
): Json {
  return {
    id,
    roomId: room.id,
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text: value }],
    createdAt: at(minute),
    streaming: false,
    refs: [],
  }
}

const approval = {
  id: 'approval-package',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs ws.',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: at(7),
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

const messages: Record<string, Json[]> = {
  'job-default': [
    text(
      'message-pinned',
      'job-default',
      { kind: 'agent', agentId: 'reviewer' },
      'Event cursors are (created_at, id).',
      2,
    ),
  ],
  'job-activity': [
    text('message-activity', 'job-activity', { kind: 'you' }, 'Build the activity feed.', 3),
    text(
      'message-builder',
      'job-activity',
      { kind: 'agent', agentId: 'builder' },
      'Read layer is ready. The feed renders newest first.',
      4,
    ),
    text('message-action', 'job-activity', { kind: 'you' }, 'Please add pagination.', 5),
    text(
      'message-edit',
      'job-activity',
      { kind: 'you' },
      'Make the cursor stable, third wording.',
      6,
    ),
    {
      ...text('message-approval', 'job-activity', { kind: 'agent', agentId: 'builder' }, '', 7),
      parts: [{ kind: 'approval', approvalId: approval.id }],
    },
  ],
  'job-notes': [
    text('message-notes', 'job-notes', { kind: 'you' }, 'Draft the 2.4 release notes.', 8),
    text(
      'message-notes-lead',
      'job-notes',
      { kind: 'agent', agentId: 'lead' },
      'Draft is ready. The migration steps are still open.',
      9,
    ),
  ],
  'job-queue': [
    text(
      'message-queue',
      'job-queue',
      { kind: 'agent', agentId: 'lead' },
      'Queue libraries compared. One clear pick, with sources and licence notes.',
      10,
    ),
  ],
  'job-closed': [
    text(
      'message-closed',
      'job-closed',
      { kind: 'agent', agentId: 'designer' },
      'Old import finished.',
      11,
    ),
  ],
}

const editOne = {
  id: 'version-edit-one',
  roomId: room.id,
  anchorId: 'message-edit-a',
  anchorCreatedAt: at(3),
  mode: 'edit',
  replacedBy: 'message-edit-b',
  number: 1,
  count: 3,
  hiddenCount: 1,
  rewound: [],
  skipped: [],
  createdAt: at(4),
}

const editTwo = {
  id: 'version-edit-two',
  roomId: room.id,
  anchorId: 'message-edit-b',
  anchorCreatedAt: at(4),
  mode: 'edit',
  replacedBy: 'message-edit',
  number: 2,
  count: 3,
  hiddenCount: 1,
  rewound: [],
  skipped: [],
  createdAt: at(5),
}

const deleted = {
  id: 'version-deleted',
  roomId: room.id,
  anchorId: 'message-deleted-anchor',
  anchorCreatedAt: at(1),
  mode: 'delete',
  replacedBy: null,
  number: 1,
  count: 1,
  hiddenCount: 2,
  rewound: [],
  skipped: [],
  createdAt: at(1),
}

const defaultExchange = {
  id: 'exchange-notes',
  jobId: 'job-notes',
  roomId: room.id,
  kind: 'review',
  parentId: null,
  from: 'lead',
  to: 'reviewer',
  state: 'paused_budget',
  round: 5,
  turnsUsed: 8,
  budget: 8,
  outcome: null,
  endedReason: null,
  pause: {
    reason: 'no_decision',
    options: ['ask_again', 'send_back', 'close'],
  },
  queuedBehind: null,
  createdAt: at(8),
  updatedAt: at(9),
}

const versions = [editOne, editTwo, deleted]

const versionItems: Record<string, Json[]> = {
  'message-edit-a': [
    text(
      'message-edit-a',
      'job-activity',
      { kind: 'you' },
      'Make the cursor stable, first wording.',
      3,
    ),
  ],
  'message-edit-b': [
    text(
      'message-edit-b',
      'job-activity',
      { kind: 'you' },
      'Make the cursor stable, second wording.',
      4,
    ),
  ],
  'message-deleted-anchor': [
    text('message-removed', 'job-activity', { kind: 'you' }, 'Old plan we replaced.', 1),
    text(
      'message-removed-answer',
      'job-activity',
      { kind: 'agent', agentId: 'builder' },
      'Old answer we replaced.',
      1,
    ),
  ],
}

const commands = {
  items: [
    { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
    {
      name: 'model',
      usage: '/model <model> <message>',
      description: 'Use a model for this message.',
    },
  ],
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
  const visibleJobs = options.empty ? jobs.filter((item) => item.isDefault) : jobs
  const exchanges = [options.exchange ?? defaultExchange]
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

    if (path === '/api/stream') return route.fulfill({ status: 204 })
    if (method === 'GET' && path === '/api/team-room')
      return response(route, {
        asOfSeq: 12,
        room,
        jobs: visibleJobs,
      })
    if (method === 'GET' && path === '/api/rooms/team-room/jobs')
      return response(route, { asOfSeq: 12, items: visibleJobs })
    if (method === 'GET' && path === '/api/rooms/team-room/messages') {
      const jobId = url.searchParams.get('jobId') ?? 'job-default'
      return response(route, {
        asOfSeq: 12,
        items: options.empty ? [] : (messages[jobId] ?? []),
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
      const message = Object.values(messages)
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
        items: options.empty ? [] : [approval],
        nextCursor: null,
      })
    if (method === 'POST' && path === `/api/approvals/${approval.id}/decision`) {
      const choice =
        typeof body === 'object' && body !== null
          ? (body as { choice?: unknown }).choice
          : undefined
      return response(route, {
        ...approval,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice, by: 'you', at: at(12) },
        delivery: 'applied',
      })
    }
    if (method === 'POST' && /^\/api\/exchanges\/[^/]+\/decision$/.test(path))
      return response(route, { ok: true })
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
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"] .top .word')).toBeVisible({ timeout: 20_000 })
  return state
}

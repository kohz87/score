import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { root } from './bold-frame-paths.mjs'

export function loadFixtures() {
  const fixtures = JSON.parse(readFileSync(join(root, 'e2e/fixtures/visual.json'), 'utf8'))
  const recipeDefinition = {
    name: 'Build, then review',
    description: 'Build it, review it, then ask before merging.',
    inputs: [{ name: 'goal', label: 'Goal', required: true, maxChars: 500 }],
    nodes: [
      {
        id: 'step1',
        kind: 'agent',
        label: 'Build it',
        agentId: 'builder',
        instruction: 'Build {{inputs.goal}}. Small, tested changes.',
        retries: 1,
        onFailure: 'route',
      },
      {
        id: 'step2',
        kind: 'agent',
        label: 'Review it',
        agentId: 'reviewer',
        instruction: 'Review the change from {{nodes.step1.output}}. End with a verdict.',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'branch1',
        kind: 'branch',
        label: 'Passed?',
        subject: 'step2',
        rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
      },
      {
        id: 'gate1',
        kind: 'gate',
        label: 'Your OK before merging',
        question: 'Merge it?',
        onReject: 'stop_run',
      },
      { id: 'end1', kind: 'end', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'step1', port: 'ok', to: 'step2' },
      { id: 'e2', from: 'step1', port: 'failed', to: 'step2' },
      { id: 'e3', from: 'step2', port: 'ok', to: 'branch1' },
      { id: 'e4', from: 'branch1', port: 'rule1', to: 'gate1' },
      { id: 'e5', from: 'branch1', port: 'default', to: 'end1' },
      { id: 'e6', from: 'gate1', port: 'ok', to: 'end1' },
    ],
  }
  const recipeVersion = {
    version: 3,
    hash: 'a'.repeat(64),
    createdAt: '2026-10-08T20:00:00.000Z',
    used: false,
    bytes: JSON.stringify(recipeDefinition).length,
    nodes: recipeDefinition.nodes.length,
    maxSteps: 3,
    workflowId: 'wf-recipe',
    definition: recipeDefinition,
  }
  const recipeSummary = {
    id: 'wf-recipe',
    name: recipeDefinition.name,
    description: recipeDefinition.description,
    latestVersion: 3,
    versionCount: 3,
    used: false,
    agentIds: ['builder', 'reviewer'],
    createdAt: '2026-10-08T20:00:00.000Z',
    updatedAt: '2026-10-08T20:30:00.000Z',
    activeRuns: 0,
  }
  const recipeFixtures = {
    '/api/workflows': {
      items: [recipeSummary],
      inventory: {
        definitions: 1,
        versions: 3,
        bytes: recipeVersion.bytes * 3,
        maxDefinitions: 200,
        maxVersionsPerDefinition: 20,
      },
    },
    '/api/workflows/wf-recipe': {
      ...recipeSummary,
      versions: [1, 2, 3].map((version) => ({ ...recipeVersion, version })),
      latest: recipeVersion,
    },
    '/api/workflows/wf-recipe/versions/3': recipeVersion,
    '/api/workflows/validate': {
      ok: true,
      stats: { nodes: 5, edges: 6, maxSteps: 3, bytes: 900 },
      issues: [],
    },
  }
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }

  const searchRoom = {
    id: 'team-room',
    name: 'Team room',
    kind: 'room',
    leadAgentId: 'lead',
    members: ['lead', 'builder', 'reviewer', 'designer'],
    unread: 0,
    activeAgents: [],
    channels: [],
    role: 'team',
    routing: 'exchanges',
  }

  const searchJob = (id, roomId, title, extra = {}) => ({
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
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    ...extra,
  })

  const readAt = (minute) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
  const roomMessage = (id, jobId, author, text, minute) => ({
    id,
    roomId: 'team-room',
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text }],
    createdAt: readAt(minute),
    streaming: false,
    refs: [],
  })

  const roomMessages = {
    'job-activity': [
      roomMessage(
        'message-activity',
        'job-activity',
        { kind: 'you' },
        'Build the activity feed.',
        3,
      ),
      roomMessage(
        'message-builder',
        'job-activity',
        { kind: 'agent', agentId: 'builder' },
        'Read layer is ready. The feed renders newest first.',
        4,
      ),
    ],
    'job-release': [
      roomMessage(
        'message-release',
        'job-release',
        { kind: 'you' },
        'Draft the 2.4 release notes.',
        5,
      ),
      roomMessage(
        'message-lead',
        'job-release',
        { kind: 'agent', agentId: 'lead' },
        'Draft is ready. The migration steps are still open.',
        6,
      ),
    ],
    'job-queue': [
      roomMessage(
        'message-queue',
        'job-queue',
        { kind: 'agent', agentId: 'lead' },
        'Queue libraries compared. One clear pick, with sources and licence notes.',
        7,
      ),
    ],
  }

  const roomExchange = {
    id: 'exchange-release',
    jobId: 'job-release',
    roomId: 'team-room',
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
    pause: { reason: 'exchange_budget', options: ['more_turns', 'step_in', 'stop'] },
    queuedBehind: null,
    createdAt: readAt(5),
    updatedAt: readAt(6),
  }

  const emptyRoom = {
    ...searchRoom,
    id: 'empty-room',
    unread: 0,
    activeAgents: [],
  }

  function roomFixture(url) {
    if (url.pathname === '/api/rooms/empty-room')
      return { asOfSeq: 1, room: emptyRoom, filesInPlay: [], learned: [] }
    if (url.pathname === '/api/rooms/empty-room/jobs') return { asOfSeq: 1, items: [] }
    if (url.pathname === '/api/rooms/empty-room/messages')
      return {
        asOfSeq: 1,
        items: [],
        nextCursor: null,
        jobId: url.searchParams.get('jobId'),
      }
    if (url.pathname === '/api/rooms/empty-room/pins') return { items: [] }
    if (url.pathname === '/api/rooms/empty-room/versions') return { asOfSeq: 1, items: [] }
    if (url.pathname === '/api/rooms/team-room/jobs')
      return { asOfSeq: 1, items: searchFixtures['/api/team-room'].jobs }
    if (url.pathname === '/api/rooms/team-room/messages') {
      const jobId = url.searchParams.get('jobId') ?? ''
      return { asOfSeq: 1, items: roomMessages[jobId] ?? [], nextCursor: null, jobId }
    }
    if (url.pathname === '/api/rooms/team-room/pins')
      return {
        items: [
          {
            messageId: 'message-builder',
            text: 'Read layer is ready.',
            pinnedAt: readAt(4),
          },
        ],
      }
    if (url.pathname === '/api/rooms/team-room/versions') return { asOfSeq: 1, items: [] }
    if (url.pathname === '/api/approvals') return { asOfSeq: 1, items: [], nextCursor: null }
    const exchange = /^\/api\/jobs\/([^/]+)\/exchanges$/.exec(url.pathname)
    if (exchange)
      return {
        asOfSeq: 1,
        items: decodeURIComponent(exchange[1]) === 'job-release' ? [roomExchange] : [],
      }
    return undefined
  }

  // PLAN 11.10f: representative search rows, so the comparison exercises every prototype group without a server.
  const searchFixtures = {
    '/api/team-room': {
      asOfSeq: 1,
      room: searchRoom,
      jobs: [
        searchJob('job-activity', 'team-room', 'Activity feed', { unread: 2 }),
        searchJob('job-release', 'team-room', 'Release notes 2.4', {
          state: 'waiting_on_you',
          unread: 3,
        }),
        searchJob('job-queue', 'team-room', 'Queue research', { state: 'closed' }),
      ],
    },
    '/api/agents/builder/direct': {
      asOfSeq: 1,
      room: null,
      chats: [
        searchJob('chat-cursor', 'direct-builder', 'The cursor bug', {
          summary: 'Why the cursor jumps',
        }),
        searchJob('chat-socket', 'direct-builder', 'Websockets or server-sent events', {
          summary: 'One connection for the feed',
        }),
      ],
    },
    ...Object.fromEntries(
      ['lead', 'reviewer', 'designer'].map((id) => [
        `/api/agents/${id}/direct`,
        { asOfSeq: 1, room: null, chats: [] },
      ]),
    ),
    '/api/knowledge/tree': {
      folders: ['Decisions', 'Projects'],
      documents: [],
      notes: [
        {
          path: 'Decisions/Event-cursors.md',
          title: 'Event cursors',
          mtime: '2026-10-24T09:00:00.000Z',
          lastAuthor: { agentId: 'reviewer' },
        },
        {
          path: 'Projects/Roadmap.md',
          title: 'Roadmap',
          mtime: '2026-10-23T09:00:00.000Z',
          lastAuthor: { agentId: 'lead' },
        },
        {
          path: 'Decisions/Websockets.md',
          title: 'Websockets vs SSE',
          mtime: '2026-10-22T09:00:00.000Z',
          lastAuthor: { agentId: 'builder' },
        },
      ],
    },
    '/api/knowledge/search': {
      items: [
        {
          path: 'Decisions/Event-cursors.md',
          title: 'Event cursors',
          kind: 'note',
          type: null,
          snippet: 'Page task events by (created_at, id), never by a [[cursor]] alone.',
        },
      ],
    },
    '/api/search/messages': {
      items: [
        {
          messageId: 'message-cursor',
          roomId: 'team-room',
          roomName: 'Team room',
          jobId: 'job-activity',
          author: { kind: 'agent', agentId: 'reviewer' },
          createdAt: '2026-10-24T10:00:00.000Z',
          snippet: 'Make the [[cursor]] (created_at, id) and add a test.',
        },
      ],
    },
    '/api/commands': {
      items: [
        { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
        { name: 'model', usage: '/model <model> <message>', description: 'Use a model.' },
      ],
    },
  }

  return { fixtures, recipeFixtures, roomFixture, searchFixtures, contentTypes }
}

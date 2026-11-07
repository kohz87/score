type Json = Record<string, unknown>

export const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

export const room = {
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

export const jobs = [
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

export const approval = {
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

export const triggerSource = {
  app: 'Tickets',
  ref: 'TCK-142',
  title: 'Checkout drops the last cart line',
  link: 'https://tickets.example.com/TCK-142',
  triggerId: 'trigger-support',
  missing: [],
}

export const messages: Record<string, Json[]> = {
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

export const deleted = {
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

export const defaultExchange = {
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

export const versions = [editOne, editTwo, deleted]

export const versionItems: Record<string, Json[]> = {
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

export const commands = {
  items: [
    { name: 'assign', usage: '/assign @agent <title>', description: 'Create a task.' },
    {
      name: 'model',
      usage: '/model <model> <message>',
      description: 'Use a model for this message.',
    },
  ],
}

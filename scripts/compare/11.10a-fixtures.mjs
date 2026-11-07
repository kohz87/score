import { join } from 'node:path'
import { root } from './11.10a-config.mjs'

const at = (minute) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
export const board = (number) => {
  const names = {
    '03': '03-phone-room',
    18: '18-phone-jobs',
    19: '19-phone-one-to-one',
    20: '20-phone-team',
  }
  return `file://${join(root, 'docs/design/bold', `${names[number]}.dc.html`)}`
}

const agent = (id, role, color, shape, status = 'idle', activity = null) => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})
export const agents = [
  agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot'),
  agent('builder', 'Builds features', '#19C39A', 'triangle', 'waiting', 'waiting for your OK'),
  agent('reviewer', 'Checks the work', '#FFB61E', 'diamond', 'working', 'reading release notes'),
  agent(
    'designer',
    'Designs screens',
    '#FF6B8A',
    'square',
    'working',
    'sketching the announcement',
  ),
]

export const teamRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: ['builder', 'reviewer', 'designer'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function job(id, title, extra = {}) {
  return {
    id,
    roomId: teamRoom.id,
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
  job('job-default', 'Team room', { isDefault: true, holderAgentId: 'lead' }),
  job('job-activity', 'Activity feed', { unread: 2, holderAgentId: 'builder' }),
  job('job-notes', 'Release notes 2.4', {
    state: 'waiting_on_you',
    holderAgentId: 'lead',
    unread: 3,
  }),
  job('job-queue', 'Queue research', {
    state: 'done',
    holderAgentId: 'lead',
    summary: 'one clear pick',
  }),
]

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
  choices: ['once', 'deny'],
  createdAt: at(7),
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

function text(id, jobId, author, value, minute) {
  return {
    id,
    roomId: teamRoom.id,
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text: value }],
    createdAt: at(minute),
    streaming: false,
    refs: [],
  }
}

export const messages = {
  'job-default': [],
  'job-activity': [
    text('activity-request', 'job-activity', { kind: 'you' }, 'Build the activity feed.', 3),
    text(
      'activity-builder',
      'job-activity',
      { kind: 'agent', agentId: 'builder' },
      'Read layer is ready. The feed renders newest first.',
      4,
    ),
    text(
      'activity-review',
      'job-activity',
      { kind: 'agent', agentId: 'reviewer' },
      'Approved, after one fix.',
      5,
    ),
    text(
      'activity-done',
      'job-activity',
      { kind: 'agent', agentId: 'lead' },
      'Done. Here it is.',
      6,
    ),
  ],
  'job-notes': [text('notes-request', 'job-notes', { kind: 'you' }, 'Draft the release notes.', 8)],
  'job-queue': [
    text(
      'queue-answer',
      'job-queue',
      { kind: 'agent', agentId: 'lead' },
      'One clear pick, with sources and licence notes.',
      10,
    ),
  ],
}

export const directRoom = {
  ...teamRoom,
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct',
  role: 'direct',
  routing: 'exchanges',
  leadAgentId: 'builder',
  members: ['builder'],
  activeAgents: [],
}
export const directChat = job('job-direct-websockets', 'Websockets or server-sent events', {
  roomId: directRoom.id,
  holderAgentId: 'builder',
  summary: 'Why websockets and not server-sent events?',
  messageCount: 2,
})
export const directMessages = [
  text(
    'direct-you',
    directChat.id,
    { kind: 'you' },
    'Why websockets and not server-sent events?',
    3,
  ),
  {
    ...text(
      'direct-builder',
      directChat.id,
      { kind: 'agent', agentId: 'builder' },
      'Server-sent events only go one way. We’ll want to pause and resume the feed from the browser later, and a socket does both over one connection.',
      4,
    ),
    roomId: directRoom.id,
  },
]

export const outside = {
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

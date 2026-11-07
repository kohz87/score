const at = (minute) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`

const agent = (id, role, color, shape, status = 'idle') => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})
export const agents = [
  agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot'),
  agent('builder', 'Builds features', '#19C39A', 'triangle', 'waiting'),
  agent('reviewer', 'Checks the work', '#FFB61E', 'diamond'),
  agent('designer', 'Designs screens', '#FF6B8A', 'square'),
]

export const teamRoom = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: ['builder'],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

function job(id, roomId, title, extra = {}) {
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

export const teamJobs = [
  job('job-default', teamRoom.id, 'Team room', { isDefault: true, holderAgentId: 'lead' }),
  job('job-activity', teamRoom.id, 'Activity feed', { unread: 2 }),
  job('job-notes', teamRoom.id, 'Release notes 2.4', {
    state: 'waiting_on_you',
    holderAgentId: 'lead',
    unread: 3,
  }),
]

export const olderRoom = {
  id: 'room-old',
  name: '#activity-feed',
  kind: 'room',
  leadAgentId: null,
  members: agents.map((item) => item.id),
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'room',
  routing: 'mentions',
}
export const oldJob = job('job-old', olderRoom.id, olderRoom.name, {
  isDefault: true,
  holderAgentId: null,
})

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

export const message = {
  id: 'message-old',
  roomId: olderRoom.id,
  jobId: oldJob.id,
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [{ kind: 'text', text: 'The feed is live. Ask builder for the cursor work.' }],
  createdAt: at(3),
  streaming: false,
  refs: [],
}

export const importedMessages = [
  {
    id: 'import:1',
    roomId: 'room-imported',
    jobId: 'job-imported',
    author: { kind: 'you' },
    to: [],
    parts: [{ kind: 'text', text: 'Plan the launch checklist.' }],
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
    parts: [{ kind: 'text', text: 'Outline it, then freeze the release branch.' }],
    createdAt: '2026-10-23T08:01:00.000Z',
    streaming: false,
    refs: [],
  },
]

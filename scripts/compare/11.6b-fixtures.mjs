const agent = (id, role, color, shape, status, activity = null) => ({
  id,
  name: id,
  role,
  style: { color, shape },
  status,
  activity,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
})

const builder = agent(
  'builder',
  'Builds features',
  '#19C39A',
  'triangle',
  'waiting',
  'Waiting for your OK',
)
const reviewer = agent('reviewer', 'Reviews changes', '#FFB61E', 'diamond', 'idle')
const designer = agent('designer', 'Designs interfaces', '#FF6B8A', 'square', 'idle')
const lead = agent('lead', 'Leads the team', '#6B4EFF', 'circle-dot', 'idle')
export const agents = [lead, builder, reviewer, designer]

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

export const job = {
  id: 'job-feed',
  roomId: room.id,
  title: 'Activity feed',
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  spendCapUsd: null,
  recipe: null,
  unread: 0,
  activeAgents: ['builder'],
  lastMessageAt: '2026-10-24T10:05:00.000Z',
  messageCount: 4,
  summary: null,
  source: null,
  reportBack: null,
  createdAt: '2026-10-24T09:00:00.000Z',
  updatedAt: '2026-10-24T10:05:00.000Z',
}

const screenFrame = {
  seq: 12,
  at: '2026-10-24T10:05:00.000Z',
  agentId: 'builder',
  runId: 'run-feed',
  surface: 'terminal',
  terminal: {
    cwd: '~/app',
    command: 'pnpm test api/events',
    output:
      'ok  pages newest first\nok  keeps same-millisecond events\nwaiting  for your OK to install ws@8',
    status: 'running',
  },
  caption: 'Ran pnpm test api/events',
}

export const workbench = {
  asOfSeq: 12,
  files: [
    {
      path: 'api/events.py',
      language: 'python',
      exact: false,
      lines: [
        { n: 1, text: 'PAGE_SIZE = 50', by: 'builder' },
        { n: 2, text: '', by: 'builder' },
        { n: 3, text: 'def page(after):', by: 'builder' },
        { n: 4, text: '    # (created_at, id): both events come through.', by: 'builder' },
        { n: 5, text: '    rows = db.events.where(cursor__gt=after)', by: 'builder' },
        { n: 6, text: '    return rows[:PAGE_SIZE]', by: 'builder' },
        { n: 7, text: '', by: 'builder' },
        { n: 8, text: 'def newest():', by: 'builder' },
        { n: 9, text: '    return page(after=None)', by: 'builder' },
      ],
      cursors: [{ agentId: 'builder', line: 9, at: '2026-10-24T10:04:00.000Z' }],
      comments: [
        {
          id: 'note-send-back',
          by: 'reviewer',
          line: null,
          originalLine: 5,
          text: 'Two events in one millisecond: the second is skipped.',
          outdated: true,
          exchangeId: 'exchange-1',
          kind: 'send_back',
          at: '2026-10-24T09:15:00.000Z',
        },
        {
          id: 'note-approve',
          by: 'reviewer',
          line: 9,
          originalLine: 9,
          text: 'Nice: the page size is one constant.',
          outdated: false,
          exchangeId: 'exchange-2',
          kind: 'approve',
          at: '2026-10-24T09:20:00.000Z',
        },
      ],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
    {
      path: 'api/test_events.py',
      language: 'python',
      exact: true,
      lines: [{ n: 1, text: 'def test_same_millisecond():', by: 'builder' }],
      cursors: [],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T09:10:00.000Z',
    },
  ],
  looseComments: [],
  drafts: [],
  screens: [{ live: true, frame: screenFrame }],
}

export const approval = {
  id: 'approval-ws',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs it.',
  choices: ['once', 'deny'],
  createdAt: '2026-10-24T09:17:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: 'Only this command is waiting.',
  refs: [],
}

const frames = [
  {
    seq: 1,
    at: '2026-10-24T09:08:00.000Z',
    agentId: 'builder',
    runId: 'run-feed',
    surface: 'terminal',
    terminal: { cwd: '~/app', command: 'ls', output: 'api  tests', status: 'ok' },
    caption: 'Listed the files',
  },
  {
    seq: 2,
    at: '2026-10-24T09:14:00.000Z',
    agentId: 'builder',
    runId: 'run-feed',
    surface: 'browser',
    browser: { url: 'http://localhost:5173/feed', title: 'Activity feed', imageUrl: null },
    caption: 'Opened the activity feed',
  },
  screenFrame,
]

export const watch = {
  asOfSeq: 12,
  agent: builder,
  live: true,
  sessionId: 'session-feed',
  frames,
  markers: [
    { seq: 1, at: '2026-10-24T09:08:00.000Z', kind: 'command' },
    { seq: 2, at: '2026-10-24T09:14:00.000Z', kind: 'browser' },
    { seq: 12, at: '2026-10-24T10:05:00.000Z', kind: 'command' },
  ],
  gaps: [],
}

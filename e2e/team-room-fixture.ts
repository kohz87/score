// The team room as the bold shell reads it, with one empty default job: fixture-based specs that show a page next to the
// room use it so a baseline never captures the room's error state.
const at = '2026-10-24T10:00:00.000Z'
const room = {
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
const job = {
  id: 'job-default',
  roomId: 'team-room',
  title: 'Team room',
  state: 'working',
  holderAgentId: 'lead',
  isDefault: true,
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
  createdAt: at,
  updatedAt: at,
}

export const teamRoomFixtures: Record<string, unknown> = {
  '/api/team-room': { asOfSeq: 1, room, jobs: [job] },
  '/api/rooms/team-room/jobs': { asOfSeq: 1, items: [job] },
  '/api/rooms/team-room/jobs?closed=include': { asOfSeq: 1, items: [job] },
  '/api/rooms/team-room/messages?limit=50': { asOfSeq: 1, items: [], nextCursor: null },
  '/api/rooms/team-room/messages?limit=50&jobId=job-default': {
    asOfSeq: 1,
    items: [],
    nextCursor: null,
  },
  '/api/rooms/team-room/versions': { asOfSeq: 1, items: [] },
  '/api/rooms/team-room/pins': { asOfSeq: 1, items: [] },
}

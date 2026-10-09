import { readFileSync } from 'node:fs'
import {
  AgentDetailSchema,
  AgentsSnapshotSchema,
  ApprovalsPageSchema,
  CommandsResponseSchema,
  ConfigSearchResponseSchema,
  ConnectionsResponseSchema,
  MessagePageSchema,
  NowSnapshotSchema,
  PluginsResponseSchema,
  ProvidersResponseSchema,
  ReportsSchema,
  RoomDetailSnapshotSchema,
  RoomsSnapshotSchema,
  RulesResponseSchema,
  StreamHelloSchema,
  SystemStatusSchema,
  KnowledgeAgentUsageSchema,
  KnowledgeInfoSchema,
  KnowledgeNoteSchema,
  KnowledgeTreeSchema,
  KnowledgeHistorySchema,
  TasksSnapshotSchema,
} from '../packages/contract/src/index.ts'
import { fixtureNow, nowFixture } from './now-fixture.ts'

const minutesAgo = (minutes: number) =>
  new Date(Date.parse(fixtureNow) - minutes * 60_000).toISOString()

// Recorded with Fastify inject(), FakeScheduler at 75 seconds, fake mode and a throwaway DB.
// Freezing every REST read and the stream isolates screenshots from other parallel e2e mutations.
const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/visual.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
const system = SystemStatusSchema.parse(recorded['/api/system'])
// A formatted reply (PLAN 5.25): Markdown, a code block, a thinking card and tool cards, newest in the room.
const roomMessages = MessagePageSchema.parse(
  recorded['/api/rooms/room-activity-feed/messages?limit=50'],
)
const formatted = {
  id: 'visual-formatted',
  roomId: 'room-activity-feed',
  author: { kind: 'agent' as const, agentId: 'builder' },
  to: [],
  parts: [
    { kind: 'thinking' as const, text: 'Page size first, then the cursor.' },
    {
      kind: 'tool' as const,
      tool: 'terminal',
      args: 'pnpm test',
      result: '3 checks passed',
      status: 'ok' as const,
    },
    {
      kind: 'tool' as const,
      tool: 'edit_file',
      args: '{"path":"src/activity-feed.ts"}',
      result: null,
      status: 'error' as const,
    },
    {
      kind: 'text' as const,
      text: '## Pagination\n\nI added a **page size** and kept the newest items first:\n\n```ts\nconst pageSize = 25 // items per page\n```\n\n- the cursor is opaque\n- see [the notes](https://example.com)',
    },
  ],
  createdAt: '2099-01-01T00:00:00.000Z',
  streaming: false,
  refs: [],
}
// 5.29: a month of runs and spend, and a cache hit rate, so the Reports extras are in the pictures.
const recordedReport = recorded['/api/reports?range=7d'] as {
  totals: object
  byAgent: object[]
}
const extras = {
  totals: { ...recordedReport.totals, cacheHitRate: 0.64 },
  byAgent: recordedReport.byAgent.map((row, index) => ({
    ...row,
    cacheHitRate: index % 2 === 0 ? 0.71 - index * 0.05 : null,
  })),
  trend: Array.from({ length: 30 }, (_, day) => ({
    date: new Date(Date.parse(fixtureNow) - (29 - day) * 86_400_000).toISOString().slice(0, 10),
    runs: 2 + ((day * 7) % 9),
    spendUsd: day < 6 ? null : Math.round((1.4 + ((day * 5) % 7) * 0.6) * 100) / 100,
  })),
}
export const visualFixtures: Record<string, unknown> = {
  '/api/settings/currency': { code: 'USD', rate: 1 },
  '/api/settings/model-visibility': { items: [] },
  '/api/agents/lead/model-settings': {
    fallbacks: [],
    fallbacksEditable: true,
    aliases: [],
    speech: {
      stt: { provider: null, model: null },
      tts: { provider: 'edge', model: null, voice: 'en-US-AriaNeural' },
    },
  },
  '/api/models?all=1': {
    items: [
      ['openai-codex', 'ChatGPT (Codex)', 'gpt-6.1-sol'],
      ['nous', 'Nous Portal', 'upstage/solar-mini4:free'],
      ['local', 'Local server', 'local-gpt-mini'],
    ].map(([provider, providerLabel, model]) => ({
      provider,
      providerLabel,
      model,
      available: true,
      reason: null,
      free: false,
      price: null,
    })),
  },
  '/api/system/logs?limit=200': {
    available: true,
    items: [
      {
        time: minutesAgo(1),
        level: 'info',
        message: 'request completed',
        method: 'GET',
        url: '/api/now',
        status: 200,
        durationMs: 4.2,
      },
      {
        time: minutesAgo(3),
        level: 'warn',
        message: 'Slow response from the Hermes gateway',
        method: null,
        url: null,
        status: null,
        durationMs: null,
      },
      {
        time: minutesAgo(9),
        level: 'info',
        message: 'Score started',
        method: null,
        url: null,
        status: null,
        durationMs: null,
      },
    ],
  },
  '/api/system': system,
  '/api/now': NowSnapshotSchema.parse(nowFixture('room-activity-feed')),
  '/api/commands': CommandsResponseSchema.parse({ items: [] }),
  '/api/agents': AgentsSnapshotSchema.parse(recorded['/api/agents']),
  '/api/agents/builder': AgentDetailSchema.parse(recorded['/api/agents/builder']),
  // The tab keyboard test lands on the History tab, which reads this.
  '/api/agents/builder/history': { items: [], nextCursor: null },
  '/api/rooms': RoomsSnapshotSchema.parse(recorded['/api/rooms']),
  '/api/shares': { items: [] },
  '/api/knowledge/agent-usage': { items: [] },
  '/api/rooms/room-activity-feed': RoomDetailSnapshotSchema.parse(
    recorded['/api/rooms/room-activity-feed'],
  ),
  '/api/rooms/room-activity-feed/messages?limit=50': MessagePageSchema.parse({
    ...roomMessages,
    items: [formatted, ...roomMessages.items],
  }),
  ...Object.fromEntries(
    ['lead', 'builder', 'reviewer', 'designer'].map((id) => [
      `/api/agents/${id}/context`,
      {
        model: 'demo-model',
        tokens: { input: 48_000, output: 6_000 },
        costUsd: 0.0312,
        contextLength: 128_000,
      },
    ]),
  ),
  // Hermes todo lists: none in the pictures (the agent pages and Now would grow a Todo card).
  ...Object.fromEntries(
    ['lead', 'builder', 'reviewer', 'designer'].map((id) => [`/api/agents/${id}/todos`, null]),
  ),
  '/api/approvals?status=all': ApprovalsPageSchema.parse(recorded['/api/approvals?status=all']),
  '/api/tasks': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/tasks?room=room-activity-feed': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/reports?range=7d': ReportsSchema.parse({ ...recordedReport, ...extras }),
  // Reports warms the other presets once the first one loads; the picture only needs them to exist.
  '/api/reports?range=today': ReportsSchema.parse({
    ...recordedReport,
    ...extras,
    range: 'today',
  }),
  '/api/reports?range=30d': ReportsSchema.parse({
    ...recordedReport,
    ...extras,
    range: '30d',
  }),
  '/api/settings/providers': ProvidersResponseSchema.parse(recorded['/api/settings/providers']),
  '/api/settings/connections': ConnectionsResponseSchema.parse(
    recorded['/api/settings/connections'],
  ),
  '/api/settings/plugins?agent=lead': PluginsResponseSchema.parse({
    items: [
      {
        id: 'score-bridge',
        label: 'score-bridge',
        enabled: true,
        locked: true,
        description: 'Lets Score see what this agent does.',
      },
      {
        id: 'memory-notes',
        label: 'memory-notes',
        enabled: true,
        locked: false,
        description: 'Keeps short notes between sessions.',
      },
      { id: 'image-tools', label: 'image-tools', enabled: false, locked: false, description: null },
    ],
  }),
  '/api/knowledge': KnowledgeInfoSchema.parse({
    vault: '/home/you/score-vault',
    notes: 4,
    gitAvailable: true,
    agentAccess: true,
  }),
  '/api/knowledge/agent-usage': KnowledgeAgentUsageSchema.parse({
    items: [
      { agentId: 'builder', writesToday: 3 },
      { agentId: 'reviewer', writesToday: 1 },
    ],
  }),
  '/api/knowledge/tree': KnowledgeTreeSchema.parse({
    folders: ['projects', 'projects/archive'],
    notes: [
      { path: 'Home.md', title: 'Home', mtime: minutesAgo(600), lastAuthor: 'you' },
      {
        path: 'projects/launch-plan.md',
        title: 'Launch plan',
        mtime: minutesAgo(12),
        lastAuthor: { agentId: 'builder' },
      },
      { path: 'projects/ideas.md', title: 'Ideas', mtime: minutesAgo(300), lastAuthor: 'you' },
      {
        path: 'projects/archive/old-notes.md',
        title: 'Old notes',
        mtime: minutesAgo(5000),
        lastAuthor: 'you',
      },
    ],
  }),
  '/api/knowledge/notes/projects/launch-plan.md': KnowledgeNoteSchema.parse({
    path: 'projects/launch-plan.md',
    title: 'Launch plan',
    frontmatter: { status: 'draft', owner: 'lead' },
    body: '# Launch plan\n\nShip the first version to the team.\n\n## Steps\n\n- Collect feedback in [[ideas]]\n- Write the *announcement*\n- Check `pnpm check` is green\n\n> Keep it small. See [[Roadmap]] too.\n',
    etag: 'visual-etag',
    mtime: minutesAgo(12),
    links: [
      { target: 'ideas', path: 'projects/ideas.md' },
      { target: 'Roadmap', path: null },
    ],
    backlinks: [{ path: 'Home.md', title: 'Home' }],
    lastAuthor: { agentId: 'builder' },
  }),
  '/api/knowledge/notes/projects/launch-plan.md/history': KnowledgeHistorySchema.parse({
    items: [
      {
        commit: 'abc1234',
        at: minutesAgo(12),
        author: { agentId: 'builder' },
        message: 'builder: update launch-plan.md',
      },
      { commit: 'def5678', at: minutesAgo(300), author: 'you', message: 'Update launch-plan.md' },
    ],
  }),
  '/api/settings/rules': RulesResponseSchema.parse(recorded['/api/settings/rules']),
  '/api/settings/config?q=': ConfigSearchResponseSchema.parse(recorded['/api/settings/config?q=']),
}
export const visualHello = StreamHelloSchema.parse({
  type: 'stream.hello',
  data: { epoch: 'visual-qa', headSeq: 47, mode: 'fake', system },
})

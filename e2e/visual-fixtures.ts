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
  TasksSnapshotSchema,
} from '../packages/contract/src/index.ts'
import { nowFixture } from './now-fixture.ts'

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
export const visualFixtures: Record<string, unknown> = {
  '/api/system': system,
  '/api/now': NowSnapshotSchema.parse(nowFixture('room-activity-feed')),
  '/api/commands': CommandsResponseSchema.parse({ items: [] }),
  '/api/agents': AgentsSnapshotSchema.parse(recorded['/api/agents']),
  '/api/agents/builder': AgentDetailSchema.parse(recorded['/api/agents/builder']),
  // The tab keyboard test lands on the History tab, which reads this.
  '/api/agents/builder/history': { items: [], nextCursor: null },
  '/api/rooms': RoomsSnapshotSchema.parse(recorded['/api/rooms']),
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
  '/api/approvals?status=all': ApprovalsPageSchema.parse(recorded['/api/approvals?status=all']),
  '/api/tasks': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/tasks?room=room-activity-feed': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/reports?range=7d': ReportsSchema.parse(recorded['/api/reports?range=7d']),
  // Reports warms the other presets once the first one loads; the picture only needs them to exist.
  '/api/reports?range=today': ReportsSchema.parse({
    ...recorded['/api/reports?range=7d'],
    range: 'today',
  }),
  '/api/reports?range=30d': ReportsSchema.parse({
    ...recorded['/api/reports?range=7d'],
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
  '/api/settings/rules': RulesResponseSchema.parse(recorded['/api/settings/rules']),
  '/api/settings/config?q=': ConfigSearchResponseSchema.parse(recorded['/api/settings/config?q=']),
}
export const visualHello = StreamHelloSchema.parse({
  type: 'stream.hello',
  data: { epoch: 'visual-qa', headSeq: 47, mode: 'fake', system },
})

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
  '/api/rooms/room-activity-feed/messages?limit=50': MessagePageSchema.parse(
    recorded['/api/rooms/room-activity-feed/messages?limit=50'],
  ),
  '/api/approvals?status=all': ApprovalsPageSchema.parse(recorded['/api/approvals?status=all']),
  '/api/tasks': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/tasks?room=room-activity-feed': TasksSnapshotSchema.parse(recorded['/api/tasks']),
  '/api/reports?range=7d': ReportsSchema.parse(recorded['/api/reports?range=7d']),
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

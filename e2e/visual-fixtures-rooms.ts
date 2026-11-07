import {
  ApprovalsPageSchema,
  MessagePageSchema,
  RoomDetailSnapshotSchema,
  RoomVersionDetailSchema,
  RoomVersionsSchema,
} from '../packages/contract/src/index.ts'
import {
  briefDraft,
  briefVersion,
  formatted,
  recorded,
  roomMessages,
} from './visual-fixtures-data.ts'

export const visualFixturesRooms: Record<string, unknown> = {
  // The brief was edited twice (PLAN 5.35): the live message is version 3 of 3 and carries the ‹ 3 / 3 › control.
  '/api/rooms/room-activity-feed/versions': RoomVersionsSchema.parse({
    asOfSeq: 0,
    items: [
      briefVersion('visual-brief-v2', 'message-brief-0', 2),
      briefVersion('visual-brief-v1', 'visual-brief-v2', 1),
    ],
  }),
  '/api/rooms/room-activity-feed/versions/visual-brief-v2': RoomVersionDetailSchema.parse({
    version: briefVersion('visual-brief-v2', 'message-brief-0', 2),
    items: [briefDraft],
  }),
  '/api/rooms/room-activity-feed/versions/visual-brief-v1': RoomVersionDetailSchema.parse({
    version: briefVersion('visual-brief-v1', 'visual-brief-v2', 1),
    items: [
      { ...briefDraft, id: 'visual-brief-v1', parts: [{ kind: 'text', text: 'Add pagination.' }] },
    ],
  }),
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
  // Context ring and popover of the room's agents (PLAN 5.36): Hermes's breakdown for each, and the delete dialog's plan.
  ...Object.fromEntries(
    [
      'room-activity-feed',
      ...(recorded['/api/rooms'] as { directs: { id: string }[] }).directs.map((room) => room.id),
    ].flatMap((roomId) =>
      ['lead', 'builder', 'reviewer', 'designer'].map((id) => [
        `/api/agents/${id}/sessions/score-${roomId}-${id}/context`,
        {
          asOfSeq: 1,
          window: 128_000,
          used: 98_000,
          measuredAt: '2026-10-09T10:00:00.000Z',
          model: 'demo-model',
          source: 'provider_usage',
          parts: [
            { kind: 'system_prompt', label: 'System prompt', tokens: 3_200 },
            { kind: 'tool_definitions', label: 'Tool definitions', tokens: 9_400 },
            { kind: 'mcp', label: 'MCP tools', tokens: 4_100 },
            { kind: 'skills', label: 'Skills', tokens: 2_300 },
            { kind: 'memory', label: 'Memory', tokens: 1_200 },
            { kind: 'conversation', label: 'Messages', tokens: 77_800 },
          ],
          autoCompactAt: 64_000,
          compactions: 0,
        },
      ]),
    ),
  ),
  '/api/rooms/room-activity-feed/delete-plan': {
    name: '#activity-feed',
    messages: 18,
    files: 2,
    runs: 5,
    briefs: 1,
    blocked: null,
  },
  // Hermes todo lists: none in the pictures (the agent pages and Now would grow a To do card).
  ...Object.fromEntries(
    ['lead', 'builder', 'reviewer', 'designer'].map((id) => [`/api/agents/${id}/todos`, null]),
  ),
  '/api/approvals?status=all': ApprovalsPageSchema.parse(recorded['/api/approvals?status=all']),
}

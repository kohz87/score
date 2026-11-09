import {
  AgentDetailSchema,
  AgentsSnapshotSchema,
  CommandsResponseSchema,
  NowSnapshotSchema,
  RoomsSnapshotSchema,
} from '../packages/contract/src/index.ts'
import { nowFixture } from './now-fixture.ts'
import {
  builtinTheme,
  focusApproval,
  journeyFixture,
  minutesAgo,
  recorded,
  system,
} from './visual-fixtures-data.ts'

export const visualFixturesCore: Record<string, unknown> = {
  '/api/themes': {
    items: [
      builtinTheme('score', 'Score'),
      builtinTheme('paper', 'Paper'),
      builtinTheme('night', 'Night shift'),
      builtinTheme('dense', 'Dense'),
    ],
    active: 'score',
    mode: 'system',
  },
  '/api/session/security': {
    passwordSet: false,
    origins: [],
    terminal: false,
    terminalUnavailable: null,
  },
  [`/api/reports/journey?from=${journeyFixture.from}&to=${journeyFixture.to}`]: journeyFixture,
  '/api/approvals/fixture-approval': focusApproval,
  '/api/settings/currency': { code: 'USD', rate: 1 },
  '/api/subagent-setup': { agents: [] },
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
  '/api/about': {
    version: '1.3.0',
    commit: '1a2b3c4',
    schema: 67,
    contract: 1,
    hermes: { version: '0.9.0' },
    node: 'v24.0.0',
    mode: 'live',
    repository: 'https://github.com/kohz87/score',
    checkout: '/home/user/score',
    service: false,
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
  // 3.21.0: the chat list reads every room's jobs for its second line and its order; these rooms have none here.
  ...Object.fromEntries(
    (() => {
      const read = recorded['/api/rooms'] as { rooms: { id: string }[]; directs: { id: string }[] }
      return [...read.rooms, ...read.directs].map((room) => [
        `/api/rooms/${room.id}/jobs?closed=include`,
        { asOfSeq: 1, items: [] },
      ])
    })(),
  ),
  '/api/shares': { items: [] },
  '/api/orchestrations': { asOfSeq: 0, items: [] },
  '/api/workflow-runs': { asOfSeq: 0, items: [] },
  '/api/orchestrations/fence': {
    fenced: false,
    reason: null,
    untrustedHistory: false,
    revision: 1,
    since: null,
    items: [],
    journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
  },
  '/api/knowledge/agent-usage': { items: [] },
}

import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'

const rule = { id: 'SQL DROP', label: 'SQL DROP', pattern: 'SQL DROP', readOnly: false }
const rules = {
  mode: 'smart',
  goAhead: [rule],
  askMe: [],
  never: [],
  drift: [{ agentId: 'builder', differs: false }],
}
const provider = {
  id: 'openrouter',
  label: 'OpenRouter',
  status: 'connected',
  detail: 'API key (1)',
  usedBy: ['lead'],
}
const toolServer = { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' }
const cases = [
  ['AgentIdSchema', 'lead', ''],
  ['ShapeSchema', 'circle-dot', 'oval'],
  ['AgentStyleSchema', f.style, { ...f.style, color: '#abc' }],
  ['AgentStatusSchema', 'working', 'busy'],
  ['AgentSummarySchema', f.agent, { ...f.agent, id: '' }],
  ['AsOfSeqSchema', 0, -1],
  [
    'ErrorEnvelopeSchema',
    { error: { code: 'not_found', message: 'Missing' } },
    { error: { code: '' } },
  ],
  ['RoomsSnapshotSchema', { asOfSeq: 0, rooms: [f.room], directs: [] }, { asOfSeq: 0, rooms: [] }],
  [
    'RoomDetailSnapshotSchema',
    { asOfSeq: 3, room: f.room, filesInPlay: [], learned: [] },
    { asOfSeq: 3, room: f.room, filesInPlay: [] },
  ],
  [
    'MessagePageSchema',
    { asOfSeq: 2, items: [f.message], nextCursor: null },
    { items: [f.message], nextCursor: null },
  ],
  [
    'ApprovalsPageSchema',
    { asOfSeq: 1, items: [f.approval], nextCursor: 'c' },
    { asOfSeq: 1, items: [], nextCursor: 3 },
  ],
  [
    'TasksSnapshotSchema',
    {
      asOfSeq: 0,
      columns: { planned: [f.task], working: [], in_review: [], needs_you: [], done: [] },
    },
    { asOfSeq: 0, columns: { backlog: [] } },
  ],
  ['AgentsSnapshotSchema', { asOfSeq: 0, items: [f.agent] }, { asOfSeq: 0.5, items: [] }],
  [
    'CommandsResponseSchema',
    { items: [{ name: 'assign', usage: '/assign', description: 'x' }] },
    { items: [{}] },
  ],
  [
    'CommandResultSchema',
    { kind: 'assign', taskId: 't_1', taskKey: 'T-1' },
    { kind: 'assign', taskId: 't_1' },
  ],
  [
    'PostMessageResponseSchema',
    { message: f.message, routedTo: ['lead'], command: null },
    { message: f.message, routedTo: ['lead'] },
  ],
  ['AgentFileSchema', { content: '', etag: 'a'.repeat(64) }, { content: '', etag: 'x' }],
  ['AgentFilePreviewSchema', { diff: '' }, {}],
  ['AgentFileWriteSchema', { etag: 'b'.repeat(64) }, { etag: '' }],
  ['AgentFileConflictSchema', { etag: 'c'.repeat(64), diff: '-a\n+b' }, { etag: 'c'.repeat(64) }],
  ['RoutinesResponseSchema', { items: [f.routine] }, { items: [{}] }],
  ['RoutineDeletedSchema', { id: 'builder:j1' }, { id: '' }],
  ['RoutineRunSchema', { id: 'builder:j1', queued: true }, { id: 'builder:j1', queued: false }],
  ['AgentDetailSchema', f.agentDetail, { ...f.agentDetail, rulesFile: 'SOUL.md' }],
  ['RoutineSummarySchema', f.routine, { ...f.routine, lastRunAt: 'yesterday' }],
  ['RefSchema', f.refs[0], { kind: 'room', roomId: '' }],
  ['ApprovalChoiceSchema', 'once', 'forever'],
  ['ApprovalSchema', f.approval, { ...f.approval, createdAt: 'yesterday' }],
  ['TaskColumnSchema', 'planned', 'queued'],
  ['TaskSummarySchema', f.task, { ...f.task, progress: 1.1 }],
  ['TaskStepSchema', f.step, { ...f.step, done: 'yes' }],
  ['TaskActivitySchema', f.activity, { ...f.activity, agentId: '' }],
  ['TaskDetailSchema', f.detail, { ...f.detail, dependsOn: [''] }],
  ['RoomSchema', f.room, { ...f.room, members: [''] }],
  ['LaneBlockSchema', f.lane, { ...f.lane, end: 'later' }],
  ['MessagePartSchema', f.parts[0], { kind: 'approval', approvalId: '' }],
  ['MessageSchema', f.message, { ...f.message, author: { kind: 'agent' } }],
  ['RunSummarySchema', f.run, { ...f.run, status: 'done' }],
  ['HandoffSchema', f.handoff, { ...f.handoff, to: { agentId: 'reviewer', blockId: '' } }],
  ['SystemStatusSchema', f.system, { ...f.system, agentIsolation: 'host' }],
  ['LogLineSchema', f.log, { ...f.log, kind: 'debug' }],
  ['WatchFrameSchema', f.watch, { ...f.watch, surface: 'desktop' }],
  ['MessageDeltaSchema', f.delta, { ...f.delta, append: null }],
  ['MessageCompletedSchema', f.completed, { ...f.completed, roomId: '' }],
  ['TypingSchema', f.typing, { ...f.typing, text: 1 }],
  ['TaskActivityDataSchema', f.taskActivity, { ...f.taskActivity, item: {} }],
  ['LaneUpsertedSchema', f.laneUpserted, { ...f.laneUpserted, block: {} }],
  ['HandoffCreatedSchema', f.handoffCreated, { ...f.handoffCreated, handoff: {} }],
  ['GapRecordedSchema', f.gap, { ...f.gap, from: 'yesterday' }],
  ['MemorySavedSchema', f.memory, { ...f.memory, source: { kind: 'unknown' } }],
  ['StreamEnvelopeSchema', f.event, { ...f.event, data: [] }],
  ['StreamEventSchema', f.event, { ...f.event, seq: 0 }],
  ['StreamHelloSchema', f.hello, { ...f.hello, seq: 1 }],
  ['StreamResetSchema', f.reset, { type: 'stream.reset', data: { reason: 'unknown' } }],
  ['StreamControlFrameSchema', f.hello, f.event],
  [
    'ParsedStreamFrameSchema',
    { kind: 'event', event: f.event },
    { kind: 'event', event: { ...f.event, seq: 0 } },
  ],
  [
    'BridgeHelloRequestSchema',
    f.bridgeHelloRequest,
    { ...f.bridgeHelloRequest, privateApis: { unresolved: 'yes' } },
  ],
  [
    'BridgeHelloResponseSchema',
    f.bridgeHelloResponse,
    { ...f.bridgeHelloResponse, expiresAt: 'later' },
  ],
  ['BridgeEventSchema', f.bridgeEvent, { ...f.bridgeEvent, payload: [] }],
  ['BridgeIdentifierSchema', 'session-1', 'has space'],
  ['BridgeEventsRequestSchema', { events: [f.bridgeEvent] }, { events: [{ counter: 1 }] }],
  ['BridgeEventsResponseSchema', { ackedThrough: 1 }, { ackedThrough: '1' }],
  ['BridgeDecisionsRequestSchema', { wait: 25 }, { wait: '31' }],
  ['BridgeDecisionSchema', f.bridgeDecision, { ...f.bridgeDecision, requestId: null }],
  ['BridgeDecisionsResponseSchema', { items: [f.bridgeDecision] }, { items: [{}] }],
  ['BridgeDecisionAckRequestSchema', f.bridgeAck, { ...f.bridgeAck, outcome: 'denied' }],
  ['ProviderItemSchema', provider, { ...provider, status: 'broken' }],
  ['ProvidersResponseSchema', { items: [provider] }, { items: [{}] }],
  [
    'ConnectResultSchema',
    { next: 'run_in_terminal', command: 'hermes auth add x' },
    { next: 'now' },
  ],
  [
    'LocalProviderRequestSchema',
    { label: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm' },
    { label: 'Lab', baseUrl: 'ftp://x', model: '--m' },
  ],
  ['ToolServerSchema', toolServer, { ...toolServer, usedBy: 'nobody' }],
  [
    'MessagingPlatformSchema',
    { platform: 'slack', label: 'Slack', status: 'connected', detail: null },
    { platform: 'slack', label: 'Slack', status: 'ok', detail: null },
  ],
  [
    'ConnectionsResponseSchema',
    { toolServers: [toolServer], messaging: [] },
    { toolServers: [{}], messaging: [] },
  ],
  [
    'ToolServerRequestSchema',
    { name: 'docs', url: 'https://mcp.example.com/sse' },
    { name: 'docs', url: 'https://mcp.example.com/sse', command: ['x'] },
  ],
  ['PlatformParamSchema', 'telegram', 'Bad Name'],
  ['ApprovalModeSchema', 'manual', 'yolo'],
  ['RuleSchema', rule, { ...rule, id: '' }],
  ['RulesResponseSchema', rules, { ...rules, drift: [{ agentId: 'builder' }] }],
  ['RulesWriteResponseSchema', { ...rules, failed: ['builder'] }, rules],
  ['RulesPreviewResponseSchema', { preview: '+mode: manual' }, { preview: 1 }],
  ['NeverGlobSchema', 'git push*', '**'],
  [
    'PutRulesRequestSchema',
    { mode: 'manual', goAhead: ['SQL DROP'], never: ['git push*'] },
    { mode: 'manual', goAhead: [], never: ['*'] },
  ],
  ['PatchPermissionRequestSchema', { level: 'asks' }, { level: 'sometimes' }],
  [
    'AgentPermissionsResponseSchema',
    { items: [{ id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true }] },
    { items: [{ id: 'SQL DROP', label: 'SQL DROP', level: 'maybe', inherited: true }] },
  ],
  ['SkillItemSchema', { name: 'git', enabled: true }, { name: '', enabled: true }],
  [
    'MemoryItemSchema',
    { id: 'm-1', text: 'x', source: 'About you', at: '2026-10-01T10:00:00.000Z' },
    { id: 'm-1', text: 'x', source: 'About you', at: 'yesterday' },
  ],
  [
    'HubSkillSchema',
    {
      name: 'git',
      identifier: 'official/git',
      source: 'official',
      trust: 'trusted',
      description: '',
    },
    { name: 'git', identifier: '', source: 'official', trust: 'trusted', description: '' },
  ],
  [
    'SkillsResponseSchema',
    { items: [{ name: 'git', enabled: false }] },
    { items: [{ name: 'git' }] },
  ],
  [
    'SkillHubResponseSchema',
    {
      items: [
        {
          name: 'git',
          identifier: 'official/git',
          source: 'official',
          trust: 'trusted',
          description: '',
        },
      ],
    },
    { items: [{ name: 'git' }] },
  ],
  [
    'MemoryPageSchema',
    {
      items: [{ id: 'm-1', text: 'x', source: 'About you', at: '2026-10-01T10:00:00.000Z' }],
      nextCursor: null,
    },
    { items: [] },
  ],
  ['ConfigKeySchema', 'agent.max_turns', 'agent..x'],
  [
    'ConfigItemSchema',
    { key: 'agent.max_turns', value: 60, file: 'config.yaml', description: null },
    { key: 'agent.max_turns', file: 'config.yaml' },
  ],
  ['ConfigSearchQuerySchema', { q: 'turns' }, { q: 'x', extra: 1 }],
  [
    'ConfigSearchResponseSchema',
    { items: [] },
    {
      items: Array.from({ length: 51 }, () => ({
        key: 'a',
        value: 1,
        file: 'f',
        description: null,
      })),
    },
  ],
  ['ConfigChangeSchema', { key: 'agent.max_turns', value: 30 }, { key: 'agent.max_turns' }],
  [
    'ConfigPreviewRequestSchema',
    { changes: [{ key: 'a', value: true }] },
    {
      changes: [
        { key: 'a', value: 1 },
        { key: 'a', value: 2 },
      ],
    },
  ],
  [
    'ConfigPreviewResponseSchema',
    {
      diff: '',
      file: 'config.yaml',
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    { diff: '', file: 'config.yaml', hash: 'short' },
  ],
  [
    'ConfigApplyRequestSchema',
    {
      changes: [{ key: 'a', value: 'x' }],
      expectedDiffHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    { changes: [{ key: 'a', value: 'x' }] },
  ],
  [
    'ConfigApplyResponseSchema',
    { ok: true, restartRequired: false },
    { ok: false, restartRequired: false },
  ],
] as const satisfies ReadonlyArray<readonly [keyof typeof contract, unknown, unknown]>

test('every exported schema has valid and invalid fixtures', () => {
  const exported = Object.keys(contract).filter((name) => name.endsWith('Schema'))
  expect(cases.map(([name]) => name).sort()).toEqual(exported.sort())
})

describe.each(cases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})

test('AgentDetail extends the summary and accepts an unreadable model', () => {
  const detail = {
    ...f.agent,
    tagline: 'Builds what lead plans.',
    personality: { excerpt: 'Careful builder.', source: 'SOUL.md' },
    reportsTo: 'lead',
    worksIn: null,
    rulesFile: 'AGENTS.md',
    model: null,
    skills: [{ name: 'git', enabled: true }],
    memory: [],
    tools: [],
    helpersMax: null,
    routines: [],
    channels: [],
    permissions: [],
  }
  expect(contract.AgentDetailSchema.parse(detail)).toEqual(detail)
  expect(contract.AgentDetailSchema.safeParse({ ...detail, rulesFile: 'SOUL.md' }).success).toBe(
    false,
  )
})

test('HTTP snapshots accept asOfSeq 0 (fresh server) and reject negatives', () => {
  expect(contract.AgentsSnapshotSchema.parse({ asOfSeq: 0, items: [f.agent] }).asOfSeq).toBe(0)
  expect(contract.AgentsSnapshotSchema.safeParse({ asOfSeq: -1, items: [] }).success).toBe(false)
  expect(
    contract.TasksSnapshotSchema.parse({
      asOfSeq: 0,
      columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
    }).asOfSeq,
  ).toBe(0)
  expect(
    contract.ErrorEnvelopeSchema.parse({ error: { code: 'not_found', message: 'Unknown room' } }),
  ).toMatchObject({ error: { code: 'not_found' } })
})

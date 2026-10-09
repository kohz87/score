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
const watchMarker = { seq: 1, at: '2026-10-08T21:30:00.000Z', kind: 'command' }
const watchResponse = {
  asOfSeq: 1,
  agent: f.agent,
  live: true,
  sessionId: 'sess-1',
  frames: [f.watch],
  markers: [watchMarker],
  gaps: [{ from: watchMarker.at, to: null, reason: 'SSE replay truncated' }],
}
const watchOverviewItem = {
  agent: f.agent,
  thumbnail: null,
  status: 'Working',
  live: true,
  surface: 'terminal',
}
const searchHit = {
  messageId: 'm1',
  roomId: 'room-1',
  roomName: '#contract',
  author: { kind: 'you' },
  createdAt: f.at,
  snippet: 'a [[hit]] here',
}
const shareCreated = { id: 'share-1', url: 'https://score.test/s/abc', expiresAt: f.later }
const shareSummary = {
  id: 'share-1',
  roomId: 'room-1',
  roomName: '#contract',
  createdAt: f.at,
  expiresAt: f.later,
  views: 0,
  includeImages: false,
  status: 'active',
  roomChanged: false,
}
const outsideSession = {
  id: 's1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch',
  startedAt: f.at,
  messageCount: 4,
  busy: false,
  roomId: null,
}
const uuid = '00000000-0000-4000-8000-000000000001'
const hash = 'a'.repeat(64)
const createInput = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds',
  style: f.style,
  model: 'm',
}
const createRequest = { ...createInput, previewHash: hash }
const preview = {
  kind: 'create',
  targetName: 'helper',
  hash,
  inherited: {
    memories: [],
    skills: [],
    plugins: [],
    approvalSettings: [],
    credentialsPresent: [],
  },
  effects: [],
  blockers: [],
  pendingWork: {
    activeRuns: 0,
    queuedTurns: 0,
    pendingApprovals: 0,
    assignments: 0,
    disposition: '',
  },
  exportPath: null,
}
const operation = {
  id: uuid,
  kind: 'create',
  targetName: 'helper',
  incarnationId: uuid,
  requestHash: hash,
  state: 'running',
  steps: [{ name: 'create_profile', state: 'pending' }],
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
  nextStep: 'create_profile',
  error: null,
  exportPath: null,
}
const flowNode = {
  id: 'task:t_1',
  kind: 'step',
  title: 'Build',
  agentId: 'builder',
  state: 'working',
  subtitle: 'builder',
  taskId: 't_1',
  layout: { col: 1, row: 0 },
}
const flowEdge = { id: 'e1', from: 'brief:brief-1', to: 'task:t_1', kind: 'flow', label: null }
const cases = [
  ['AgentCreateInputSchema', createInput, { ...createInput, id: 'Bad Id' }],
  ['AgentCreateRequestSchema', createRequest, { ...createRequest, previewHash: 'x' }],
  ['AgentPatchRequestSchema', { name: 'New' }, {}],
  ['AgentDeleteRequestSchema', { typedName: 'helper', previewHash: hash }, { typedName: 'helper' }],
  ['AgentPreviewRequestSchema', { kind: 'delete', agentId: 'helper' }, { kind: 'delete' }],
  ['AgentPreviewSchema', preview, { ...preview, hash: undefined }],
  ['AgentOperationSchema', operation, { ...operation, state: 'bogus' }],
  [
    'AgentImportRequestSchema',
    {
      uploadId: '30000000-0000-4000-8000-000000000001',
      id: 'helper',
      name: 'Helper',
      role: 'r',
      style: f.style,
    },
    { uploadId: 'not-a-uuid', id: 'helper', name: 'Helper', role: 'r', style: f.style },
  ],
  ['ProfileImportUploadIdSchema', '30000000-0000-4000-8000-000000000001', 'x'],
  [
    'ImportInspectionSchema',
    {
      uploadId: '30000000-0000-4000-8000-000000000001',
      sizeBytes: 10,
      archiveRoot: 'scout',
      suggestedId: 'scout',
      description: null,
      model: null,
      configVersion: null,
      skills: [],
      plugins: [],
      memoryBytes: 0,
      fileCount: 1,
      totalBytes: 10,
      credentialFiles: [],
      hasBridge: false,
      warnings: [],
    },
    { uploadId: 'x' },
  ],
  ['ProfileNameSchema', 'helper', 'Helper'],
  ['ProfileStepNameSchema', 'create_profile', 'other'],
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
  [
    'RoomsSnapshotSchema',
    { asOfSeq: 0, rooms: [f.room], directs: [], projects: [f.roomProject] },
    { asOfSeq: 0, rooms: [] },
  ],
  ['RoomProjectSchema', f.roomProject, { ...f.roomProject, color: 'purple' }],
  [
    'AutoSummarySchema',
    { enabled: true, thresholdTokens: 12000 },
    { enabled: true, thresholdTokens: 10 },
  ],
  ['SummaryEditBodySchema', { text: 'Edited summary' }, { text: '  ' }],
  ['RoomProjectBodySchema', { name: 'Launch', color: '#4A2FD9' }, { name: '', color: '#4A2FD9' }],
  ['RoomProjectEventSchema', { id: 'project-1' }, { id: '' }],
  ['RoomTagSchema', 'q4', 'Q 4'],
  ['ProjectColorSchema', '#4A2FD9', 'purple'],
  [
    'RoomImportSchema',
    { agentId: 'lead', sessionId: 's1', source: 'telegram', label: 'Telegram', continued: null },
    { agentId: 'lead', sessionId: 's1', source: 'telegram', label: 'Telegram', continued: 'x' },
  ],
  ['MessageSearchHitSchema', searchHit, { ...searchHit, createdAt: 'yesterday' }],
  ['MessageSearchResponseSchema', { items: [searchHit] }, { items: [{}] }],
  [
    'ShareCreateRequestSchema',
    { password: 'x', expiresInDays: 7, includeImages: false },
    { password: 'x', expiresInDays: 31, includeImages: false },
  ],
  ['ShareCreatedSchema', shareCreated, { ...shareCreated, id: '' }],
  ['ShareSummarySchema', shareSummary, { ...shareSummary, status: 'revoked' }],
  ['SharesResponseSchema', { items: [shareSummary] }, { items: [{}] }],
  ['OutsideSessionSchema', outsideSession, { ...outsideSession, messageCount: -1 }],
  [
    'OutsideSessionsResponseSchema',
    { items: [outsideSession], unavailable: ['builder'] },
    { items: [outsideSession] },
  ],
  [
    'ImportSessionRequestSchema',
    { agentId: 'lead', sessionId: 's1' },
    { agentId: 'lead', sessionId: '' },
  ],
  ['ImportSessionResponseSchema', { roomId: 'room-1', imported: 3 }, { roomId: '', imported: 3 }],
  ['ContinueSessionResponseSchema', { mode: 'same_session' }, { mode: 'both' }],
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
  [
    'NowSnapshotSchema',
    {
      asOfSeq: 0,
      now: f.at,
      paused: false,
      headline: { working: 1, needsYou: 1, text: 'One agent is working. One thing needs you.' },
      lanes: [{ agent: f.agent, blocks: [f.lane] }],
      handoffs: [f.handoff, f.unattributedHandoff],
      unattributed: { blocks: [f.attemptLane] },
      focusApproval: f.approval,
      thread: { roomId: 'room-1', messages: [f.message] },
      madeToday: [
        {
          title: 'Feed',
          ref: { kind: 'task', taskId: 'task-1' },
          files: [{ path: 'a.ts', added: 0, removed: 0 }],
          checks: [
            { label: 'Tests pass', agentId: 'builder', verdict: 'passed' },
            { label: 'Review', agentId: 'reviewer', verdict: 'changes_requested' },
            { label: 'Second look', agentId: 'reviewer', verdict: 'unknown' },
          ],
        },
      ],
    },
    { asOfSeq: 0, now: f.at, headline: { working: -1, needsYou: 0, text: '' } },
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
  [
    'MessageAttachmentSchema',
    { workspace: { agentId: 'lead', path: 'src/main.ts' } },
    { workspace: { agentId: 'lead', path: '' } },
  ],
  ['AgentFileSchema', { content: '', etag: 'a'.repeat(64) }, { content: '', etag: 'x' }],
  ['AgentFilePreviewSchema', { diff: '' }, {}],
  ['AgentFileWriteSchema', { etag: 'b'.repeat(64) }, { etag: '' }],
  ['AgentFileConflictSchema', { etag: 'c'.repeat(64), diff: '-a\n+b' }, { etag: 'c'.repeat(64) }],
  ['RoutinesResponseSchema', { items: [f.routine] }, { items: [{}] }],
  ['RoutineDeletedSchema', { id: 'builder:j1' }, { id: '' }],
  ['RoutineRunSchema', { id: 'builder:j1', queued: true }, { id: 'builder:j1', queued: false }],
  ['ReportRangeSchema', '7d', 'year'],
  [
    'ReportsSchema',
    {
      range: 'today',
      summary: 'No tasks finished today.',
      totals: {
        tasksFinished: 0,
        runs: 0,
        firstPassRate: null,
        medianTaskSec: null,
        spendUsd: null,
        cacheHitRate: null,
      },
      byDay: [{ date: '2026-03-10', perAgent: { builder: 1 } }],
      timeSplit: [
        { agentId: 'builder', workingPct: 50, waitingOnYouPct: 50, waitingOnAgentPct: 0 },
      ],
      byAgent: [
        {
          agentId: 'builder',
          finished: 1,
          runs: 1,
          medianSec: 60,
          firstPassRate: null,
          spendUsd: 0.1,
          cacheHitRate: 0.5,
        },
      ],
      trend: [{ date: '2026-03-10', runs: 2, spendUsd: null }],
      approvals: { asked: 0, approved: 0, denied: 0, medianWaitSec: null, insight: null },
      unattributed: { runs: 2, workingSec: 90 },
    },
    { range: 'today' },
  ],
  ['AgentDetailSchema', f.agentDetail, { ...f.agentDetail, rulesFile: 'SOUL.md' }],
  ['RoutineSummarySchema', f.routine, { ...f.routine, lastRunAt: 'yesterday' }],
  ['RefSchema', f.refs[0], { kind: 'room', roomId: '' }],
  ['ApprovalChoiceSchema', 'once', 'forever'],
  ['ApprovalSchema', f.approval, { ...f.approval, createdAt: 'yesterday' }],
  ['TaskColumnSchema', 'planned', 'queued'],
  ['TaskSummarySchema', f.task, { ...f.task, progress: 1.1 }],
  ['BriefStatusSchema', 'paused', 'queued'],
  ['BriefSummarySchema', f.brief, { ...f.brief, status: 'queued' }],
  ['BriefsListSchema', { items: [f.brief] }, { items: [{}] }],
  ['FlowNodeSchema', flowNode, { ...flowNode, state: 'queued' }],
  ['FlowEdgeSchema', flowEdge, { ...flowEdge, kind: 'other' }],
  [
    'BriefFlowSchema',
    {
      asOfSeq: 1,
      brief: f.brief,
      nodes: [flowNode],
      edges: [flowEdge],
      stats: { runningSec: 1, steps: 1, handoffs: 0, spendUsd: null, eta: null, attempts: 2 },
      notice: null,
    },
    { asOfSeq: 1, brief: f.brief, nodes: [flowNode], edges: [flowEdge] },
  ],
  [
    'FlowNodeDetailSchema',
    {
      node: flowNode,
      description: '',
      steps: [],
      approval: null,
      run: null,
      model: null,
      tools: [],
      watch: null,
    },
    { node: flowNode },
  ],
  ['BriefLogPageSchema', { items: [f.log], nextCursor: null }, { items: [f.log] }],
  ['PlanStartResponseSchema', { briefId: 'b', taskIds: ['t'] }, { briefId: 'b', taskIds: [1] }],
  ['NodeStopResponseSchema', { ok: true }, { ok: false }],
  ['TaskStepSchema', f.step, { ...f.step, done: 'yes' }],
  ['TaskActivitySchema', f.activity, { ...f.activity, agentId: '' }],
  ['TaskDetailSchema', f.detail, { ...f.detail, dependsOn: [''] }],
  ['RoomSchema', f.room, { ...f.room, members: [''] }],
  ['LaneBlockSchema', f.lane, { ...f.lane, end: 'later' }],
  ['MessagePartSchema', f.parts[0], { kind: 'approval', approvalId: '' }],
  ['MessageSchema', f.message, { ...f.message, author: { kind: 'agent' } }],
  ['RunSummarySchema', f.run, { ...f.run, status: 'done' }],
  ['TaskRefSchema', f.taskRef, { ...f.taskRef, current: 'yes' }],
  ['AttemptSummarySchema', f.attempt, { ...f.attempt, tools: [] }],
  ['AttemptDetailSchema', f.attemptDetail, { ...f.attemptDetail, taskSnapshot: {} }],
  ['AttemptStatusSchema', 'ended_unknown', 'cancelled'],
  ['WorkItemSchema', { kind: 'attempt', attempt: f.attempt }, { kind: 'attempt', run: f.run }],
  ['HandoffSchema', f.handoff, { ...f.handoff, to: { agentId: 'reviewer', blockId: '' } }],
  ['SystemStatusSchema', f.system, { ...f.system, agentIsolation: 'host' }],
  ['LogLineSchema', f.log, { ...f.log, kind: 'debug' }],
  ['WatchFrameSchema', f.watch, { ...f.watch, surface: 'desktop' }],
  ['WatchMarkerKindSchema', 'command', 'typing'],
  ['WatchMarkerSchema', watchMarker, { ...watchMarker, seq: 0 }],
  [
    'WatchResponseSchema',
    watchResponse,
    { ...watchResponse, frames: [{ ...f.watch, surface: 'desktop' }] },
  ],
  ['WatchOverviewItemSchema', watchOverviewItem, { ...watchOverviewItem, surface: 'desktop' }],
  [
    'WatchOverviewSchema',
    { items: [watchOverviewItem] },
    { items: [{ ...watchOverviewItem, live: 'yes' }] },
  ],
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
  [
    'PairingLinkSchema',
    { url: 'http://10.1.1.199:8741/pair#abc', expiresAt: '2026-10-08T13:00:00.000Z' },
    { url: 'javascript:alert(1)', expiresAt: '2026-10-08T13:00:00.000Z' },
  ],
  [
    'PasskeySchema',
    {
      id: 'abc',
      label: 'Phone',
      createdAt: '2026-10-09T00:00:00.000Z',
      lastUsedAt: null,
      flagged: false,
    },
    { id: '', label: 'Phone', createdAt: 'x', lastUsedAt: null, flagged: false },
  ],
  [
    'PasskeysSchema',
    { available: true, rpId: 'a.example.com', items: [] },
    { available: 'yes', rpId: null, items: [] },
  ],
  ['PasskeyCeremonySchema', { challenge: 'abc' }, 'not an object'],
  ['SecurityStatusSchema', { passwordSet: true, origins: [] }, { passwordSet: 'yes' }],
  ['DisplayCurrencySchema', { code: 'EUR', rate: 0.92 }, { code: 'euro', rate: 0.92 }],
  ['LogLevelSchema', 'warn', 'debug'],
  [
    'LogEntrySchema',
    {
      time: '2026-10-09T10:00:00.000Z',
      level: 'info',
      message: 'request completed',
      method: 'GET',
      url: '/api/agents',
      status: 200,
      durationMs: 3.5,
    },
    { level: 'info' },
  ],
  ['LogsResponseSchema', { available: true, items: [] }, { items: [] }],
  ['RevokeOthersResponseSchema', { revoked: 2 }, { revoked: -1 }],
  ['OperationConfirmRequestSchema', { step: 'create_profile' }, { step: 'x', extra: 1 }],
  ['ProviderItemSchema', provider, { ...provider, status: 'broken' }],
  ['ProvidersResponseSchema', { items: [provider] }, { items: [{}] }],
  [
    'ConnectResultSchema',
    { next: 'run_in_terminal', command: 'hermes auth add x' },
    { next: 'now' },
  ],
  [
    'SignInSchema',
    {
      id: 'si-1',
      providerId: 'openai-codex',
      state: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-1234',
      expiresAt: '2026-10-08T13:00:00.000Z',
      message: null,
    },
    {
      id: 'si-1',
      providerId: 'openai-codex',
      state: 'waiting',
      url: 'http://evil.example/device',
      code: 'ABCD-1234',
      expiresAt: '2026-10-08T13:00:00.000Z',
      message: null,
    },
  ],
  [
    'ProviderKeyRequestSchema',
    { apiKey: 'sk-test-0123456789', label: 'Work key' },
    { apiKey: 'sk-test 0123456789\nsecond-answer' },
  ],
  [
    'ModelOptionSchema',
    {
      provider: 'openai-codex',
      providerLabel: 'ChatGPT (Codex)',
      model: 'gpt-6.1-sol',
      available: true,
      reason: null,
      free: false,
      price: null,
    },
    { provider: 'openai-codex', model: '' },
  ],
  ['ModelsQuerySchema', { q: 'gpt' }, { q: 'x'.repeat(101) }],
  ['ModelsResponseSchema', { items: [] }, { items: [{}] }],
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
  ['MessageDeletedSchema', f.deleted, { roomId: 'room-1' }],
  ['MessageUpdatedSchema', f.updated, { roomId: 'room-1', messageId: 'm', editedBy: 3 }],
  ['MessageProgressedSchema', f.progressed, { roomId: 'room-1', messageId: 'm', at: 'soon' }],
  ['RetryReplyResponseSchema', { messageId: 'reply-2' }, {}],
  [
    'AgentContextSchema',
    { model: 'm', tokens: { input: 10, output: 2 }, costUsd: null, contextLength: 128000 },
    { contextLength: 0 },
  ],
  [
    'MessagingFieldSchema',
    {
      key: 'SLACK_BOT_TOKEN',
      label: 'Bot token',
      help: null,
      url: null,
      secret: true,
      required: true,
    },
    { key: 'slack', label: 'Bot token', help: null, url: null, secret: true, required: true },
  ],
  ['MessagingFieldsResponseSchema', { fields: [], browserSetup: false }, { fields: [] }],
  [
    'MessagingSetupRequestSchema',
    { values: { SLACK_BOT_TOKEN: 'xoxb-1' }, agentId: 'builder' },
    { values: { SLACK_BOT_TOKEN: '-x' } },
  ],
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
  [
    'AgentChannelSchema',
    {
      platform: 'slack',
      label: 'Slack',
      status: 'disconnected',
      detail: null,
      connectCommand: 'hermes -p builder gateway setup',
    },
    { platform: 'slack', label: 'Slack', status: 'on', detail: null, connectCommand: 'x' },
  ],
  ['AgentChannelsResponseSchema', { items: [] }, { items: [{ platform: 'x' }] }],
  ['WorkspaceInfoSchema', { root: '/w', available: true, reason: null }, { root: '/w' }],
  [
    'WorkspaceEntrySchema',
    { name: 'a.txt', kind: 'file', size: 1, mtime: 'x', hidden: false },
    { name: 'a.txt', kind: 'socket', size: 1, mtime: 'x', hidden: false },
  ],
  ['WorkspaceTreeSchema', { entries: [] }, { entries: [{}] }],
  [
    'WorkspaceBinarySchema',
    { binary: true, size: 1, reason: 'binary' },
    { binary: false, size: 1 },
  ],
  ['WorkspaceWriteRequestSchema', { content: '', etag: null }, { content: 1, etag: null }],
  ['WorkspaceWriteResponseSchema', { etag: 'e' }, {}],
  ['WorkspaceCreateRequestSchema', { path: 'a', kind: 'dir' }, { path: '', kind: 'dir' }],
  ['WorkspaceMoveRequestSchema', { from: 'a', to: 'b' }, { from: 'a' }],
  ['WorkspaceRootRequestSchema', { path: '/x' }, { path: '' }],
  ['WorkspaceUploadResponseSchema', { path: 'a', size: 1 }, { path: 'a' }],
  ['WorkspaceConflictSchema', { etag: null }, { etag: 1 }],
  [
    'WorkspaceGitSchema',
    { branch: 'main', changed: 2, ahead: 0, behind: 1 },
    { branch: 'main', changed: -1, ahead: 0, behind: 0 },
  ],
  [
    'AgentTodoSchema',
    { id: 'a', content: 'Write tests', status: 'in_progress', parent: 'b' },
    { id: 'a', content: 'Write tests', status: 'blocked' },
  ],
  [
    'AgentTodosSchema',
    { todos: [], revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
    { todos: [], revision: -1, updatedAt: 'x' },
  ],
  ['KnowledgeAuthorSchema', { agentId: 'builder' }, 'someone'],
  [
    'KnowledgeInfoSchema',
    { vault: '/v', notes: 2, gitAvailable: true, agentAccess: true },
    { vault: '/v', notes: -1, gitAvailable: true, agentAccess: true },
  ],
  [
    'KnowledgeNoteSummarySchema',
    { path: 'a.md', title: 'A', mtime: 'x', lastAuthor: null },
    { path: '', title: 'A', mtime: 'x', lastAuthor: null },
  ],
  ['KnowledgeTreeSchema', { folders: ['p'], notes: [] }, { folders: 'p', notes: [] }],
  ['KnowledgeLinkSchema', { target: 'B', path: 'b.md' }, { target: 'B' }],
  [
    'KnowledgeNoteSchema',
    {
      path: 'a.md',
      title: 'A',
      frontmatter: {},
      body: '# A',
      etag: 'e1',
      mtime: 'x',
      links: [{ target: 'B', path: null }],
      backlinks: [],
      lastAuthor: 'you',
    },
    { path: 'a.md' },
  ],
  ['KnowledgeWriteRequestSchema', { body: 'x', etag: null }, { body: 'x' }],
  ['KnowledgeWriteResponseSchema', { etag: 'e', path: 'a.md' }, { etag: 'e' }],
  [
    'KnowledgeMoveRequestSchema',
    { from: 'a.md', to: 'b.md', updateLinks: true },
    { from: 'a.md', to: 'b.md' },
  ],
  [
    'KnowledgeMoveResponseSchema',
    { path: 'b.md', updatedNotes: 2 },
    { path: 'b.md', updatedNotes: -1 },
  ],
  [
    'KnowledgeSearchHitSchema',
    { path: 'a.md', title: 'A', snippet: 'x [[y]] z' },
    { path: 'a.md' },
  ],
  ['KnowledgeSearchResponseSchema', { items: [] }, { items: [{}] }],
  [
    'KnowledgeCommitSchema',
    { commit: 'abc1234', at: 'x', author: 'you', message: 'Edit' },
    { commit: 'not-a-hash', at: 'x', author: 'you', message: 'Edit' },
  ],
  ['KnowledgeHistorySchema', { items: [] }, { items: 'x' }],
  ['KnowledgeVersionSchema', { commit: 'abc1234', body: 'x' }, { commit: 'abc1234' }],
  ['KnowledgeRestoreRequestSchema', { commit: 'abc1234' }, { commit: 'HEAD' }],
  ['KnowledgeConflictSchema', { etag: null }, { etag: 1 }],
  [
    'KnowledgeChangedSchema',
    { path: 'a.md', kind: 'moved', to: 'b.md', by: 'outside' },
    { path: 'a.md', kind: 'renamed', to: null, by: 'you' },
  ],
  ['KnowledgeToolPathSchema', 'a.md', ''],
  ['BridgeKnowledgeSearchRequestSchema', { query: 'x', limit: 20 }, { query: '' }],
  ['BridgeKnowledgeReadRequestSchema', { path: 'a.md' }, {}],
  ['BridgeKnowledgeListRequestSchema', {}, { folder: 1 }],
  [
    'BridgeKnowledgeWriteRequestSchema',
    { path: 'a.md', body: 'x', expectedEtag: null },
    { path: 'a.md', body: 'x' },
  ],
  ['BridgeKnowledgeAppendRequestSchema', { path: 'a.md', text: 'x' }, { path: 'a.md', text: '' }],
  ['BridgeKnowledgeSearchResponseSchema', { items: [] }, {}],
  [
    'BridgeKnowledgeReadResponseSchema',
    { path: 'a.md', title: 'A', body: '', etag: 'e', truncated: false },
    { path: 'a.md' },
  ],
  [
    'BridgeKnowledgeListResponseSchema',
    { folders: [], notes: [], truncated: false },
    { folders: [] },
  ],
  ['BridgeKnowledgeWriteResponseSchema', { etag: 'e', path: 'a.md' }, { etag: 'e' }],
  ['KnowledgeAgentAccessSchema', { enabled: true }, { enabled: 'yes' }],
  [
    'KnowledgeAgentUsageSchema',
    { items: [{ agentId: 'builder', writesToday: 2 }] },
    { items: [{ agentId: 'builder', writesToday: -1 }] },
  ],
  ['ModelRefSchema', { provider: 'openrouter', model: 'gpt-x' }, { provider: '-x', model: 'm' }],
  ['AliasNameSchema', 'fast', 'Fast.one'],
  [
    'ModelAliasSchema',
    { name: 'fast', model: 'gpt-x', provider: null, editable: true },
    { name: 'fast', model: 'gpt-x', provider: null },
  ],
  [
    'AliasInputSchema',
    { name: 'fast', model: 'gpt-x' },
    { name: 'fast', model: 'gpt-x', key: 'k' },
  ],
  [
    'SpeechSettingsSchema',
    {
      stt: { provider: null, model: null },
      tts: { provider: 'edge', model: null, voice: 'en-US-x' },
    },
    { stt: { provider: 'nope', model: null }, tts: { provider: null, model: null, voice: null } },
  ],
  [
    'ModelSettingsSchema',
    {
      fallbacks: [{ provider: 'openrouter', model: 'gpt-x' }],
      fallbacksEditable: true,
      aliases: [],
      speech: {
        stt: { provider: null, model: null },
        tts: { provider: null, model: null, voice: null },
      },
    },
    { fallbacks: [], aliases: [] },
  ],
  [
    'ModelSettingsUpdateSchema',
    { fallbacks: [], speech: { tts: { voice: 'en-US-x' } } },
    { speech: { tts: { api_key: 'k' } } },
  ],
  [
    'ModelVisibilitySchema',
    { items: [{ provider: 'openrouter', model: 'gpt-x' }] },
    { items: [{ provider: 'openrouter' }] },
  ],
  ['HistoryOutcomeSchema', 'stopped', 'cancelled'],
  [
    'AgentHistoryItemSchema',
    {
      runId: 'r-1',
      title: 'Fix the pager',
      origin: 'kanban',
      outcome: 'completed',
      startedAt: '2026-10-01T10:00:00.000Z',
      durationSec: 90,
      model: null,
      costUsd: null,
      task: { id: 't-1', title: 'Fix the pager' },
      brief: null,
      replaySeq: 3,
    },
    { runId: 'r-1', outcome: 'done' },
  ],
  ['AgentHistoryPageSchema', { items: [], nextCursor: null }, { items: [] }],
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
  [
    'HermesCheckPartSchema',
    { name: 'Capabilities', status: 'same', detail: 'ok' },
    { name: 'Capabilities', status: 'weird', detail: 'ok' },
  ],
  [
    'HermesCheckSchema',
    {
      hash: 'a'.repeat(64),
      build: { version: '1', codeSha: null, fingerprint: 'f' },
      parts: [],
      compatible: true,
    },
    { hash: 'short', build: {}, parts: [], compatible: true },
  ],
  ['HermesAcceptRequestSchema', { hash: 'a'.repeat(64) }, { hash: 'x' }],
  ['HermesAcceptResponseSchema', { ok: true }, { ok: false }],
  [
    'PairedBrowserSchema',
    {
      id: '3f1c2b8e-5d0a-4c1e-9a77-0b1d2e3f4a5b',
      label: 'Firefox',
      address: '192.168.1.5',
      createdAt: '2026-10-08T00:00:00.000Z',
      lastSeenAt: '2026-10-08T00:00:00.000Z',
      expiresAt: '2026-10-15T00:00:00.000Z',
      current: true,
    },
    { id: 'not-a-uuid' },
  ],
  ['PairedBrowsersSchema', { items: [] }, { items: [{ id: 'x' }] }],
  ['PluginIdSchema', 'memory-notes', '--bad'],
  [
    'PluginItemSchema',
    { id: 'memory-notes', label: 'memory-notes', enabled: true, locked: false, description: null },
    { id: 'memory-notes', label: 'memory-notes', enabled: 'yes', locked: false, description: null },
  ],
  ['PluginsQuerySchema', { agent: 'builder' }, {}],
  ['PluginsResponseSchema', { items: [] }, { items: [{ id: 'x' }] }],
  ['PatchPluginRequestSchema', { enabled: false }, { enabled: false, extra: 1 }],
  ['RewindModeSchema', 'edit', 'undo'],
  ['RewindRequestSchema', { mode: 'delete', scoreOnly: true }, { mode: 'undo' }],
  [
    'RewoundAgentSchema',
    { agentId: 'builder', turnsUndone: 2 },
    { agentId: 'builder', turnsUndone: -1 },
  ],
  ['RewindSkipReasonSchema', 'compressed', 'other'],
  [
    'SkippedAgentSchema',
    { agentId: 'builder', reason: 'no_answer' },
    { agentId: 'builder', reason: 'x' },
  ],
  ['RoomVersionSchema', f.roomVersion, { ...f.roomVersion, count: 0 }],
  [
    'RewindResponseSchema',
    { version: f.roomVersion, rewound: [], skipped: [] },
    { version: f.roomVersion, rewound: 1, skipped: [] },
  ],
  [
    'RewindPlanSchema',
    { hiddenCount: 1, blocked: null, agents: [{ agentId: 'builder', turns: 1, cannot: null }] },
    { hiddenCount: 1, blocked: null, agents: [{ agentId: 'builder', turns: 1 }] },
  ],
  ['RoomVersionsSchema', { asOfSeq: 1, items: [f.roomVersion] }, { asOfSeq: 1, items: [{}] }],
  ['RoomVersionDetailSchema', { version: f.roomVersion, items: [] }, { version: f.roomVersion }],
  [
    'BridgeCommandSchema',
    { commandId: 'c1', kind: 'rewind', sessionId: 's', turns: 1, expiresAt: 1790000060 },
    { commandId: 'c1', kind: 'rewind', sessionId: 's', turns: 0, expiresAt: 1790000060 },
  ],
  [
    'BridgeCommandsResponseSchema',
    {
      items: [{ commandId: 'c1', kind: 'rewind', sessionId: 's', turns: 1, expiresAt: 1790000060 }],
    },
    { items: [{}] },
  ],
  ['BridgeCommandResultSchema', { outcome: 'nothing' }, { outcome: 'maybe' }],
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

test('messaging setup requests accept one-line values for env keys only', () => {
  const ok = contract.MessagingSetupRequestSchema.safeParse({
    values: { SLACK_BOT_TOKEN: 'xoxb-1' },
  })
  expect(ok.success).toBe(true)
  for (const values of [{ lower: 'x' }, { SLACK_BOT_TOKEN: 'a\nb' }, { SLACK_BOT_TOKEN: '-x' }])
    expect(contract.MessagingSetupRequestSchema.safeParse({ values }).success).toBe(false)
  expect(contract.MessagingSetupRequestSchema.safeParse({ values: {}, extra: 1 }).success).toBe(
    false,
  )
})

test('a stored lane block without a kind reads as a task; chat bands carry a count', () => {
  const stored: Record<string, unknown> = { ...f.lane }
  delete stored.kind
  expect(contract.LaneBlockSchema.parse(stored).kind).toBe('task')
  expect(contract.LaneBlockSchema.parse({ ...f.lane, kind: 'chat', count: 3 }).count).toBe(3)
  expect(contract.LaneBlockSchema.safeParse({ ...f.lane, kind: 'chat', count: 0 }).success).toBe(
    false,
  )
  expect(contract.LaneBlockSchema.safeParse({ ...f.lane, kind: 'other' }).success).toBe(false)
})

describe('Kanban attempts (5.17a-1) additions', () => {
  test('an unattributed, partial attempt from an earlier board parses; tools stay null', () => {
    const parsed = contract.AttemptSummarySchema.parse(f.unattributedAttempt)
    expect(parsed.agentId).toBeNull()
    expect(parsed.task.current).toBe(false)
    expect(
      contract.AttemptSummarySchema.safeParse({ ...f.unattributedAttempt, id: 'run-1' }).success,
    ).toBe(false)
    expect(contract.AttemptSummarySchema.safeParse({ ...f.attempt, model: 'x' }).success).toBe(
      false,
    )
  })
  test('WorkItem is a tagged union of runs and attempts', () => {
    expect(contract.WorkItemSchema.safeParse({ kind: 'run', run: f.run }).success).toBe(true)
    expect(contract.WorkItemSchema.safeParse({ kind: 'run', attempt: f.attempt }).success).toBe(
      false,
    )
  })
  test('attempt lane blocks carry provenance, order and the observation boundary', () => {
    expect(contract.LaneBlockSchema.parse(f.attemptLane).order).toEqual([f.at, 41])
    expect(
      contract.LaneBlockSchema.safeParse({ ...f.attemptLane, provenance: 'guess' }).success,
    ).toBe(false)
    // Blocks of runs carry none of them: today's responses are unchanged.
    expect(contract.LaneBlockSchema.parse(f.lane).provenance).toBeUndefined()
  })
  test('a hand-off may start or end in the Unattributed lane', () => {
    expect(contract.HandoffSchema.parse(f.unattributedHandoff).from.agentId).toBeNull()
    expect(
      contract.HandoffSchema.safeParse({ ...f.unattributedHandoff, from: { blockId: 'x' } })
        .success,
    ).toBe(false)
  })
  test('Flow tools: null = not observed, [] = observed none; attempts list rides along', () => {
    const base = {
      node: flowNode,
      description: '',
      steps: [],
      approval: null,
      run: null,
      model: null,
      watch: null,
    }
    expect(
      contract.FlowNodeDetailSchema.parse({ ...base, tools: null, attempts: [f.attempt] }).tools,
    ).toBeNull()
    expect(contract.FlowNodeDetailSchema.safeParse({ ...base, tools: [1] }).success).toBe(false)
  })
  test('history rows, task details and reports accept the attempt fields', () => {
    const item = {
      runId: f.attempt.id,
      title: 'T',
      origin: 'kanban',
      outcome: 'completed',
      startedAt: f.at,
      durationSec: 1,
      model: null,
      costUsd: null,
      task: null,
      brief: null,
      replaySeq: null,
      attempt: f.attempt,
    }
    expect(contract.AgentHistoryItemSchema.parse(item).attempt?.kind).toBe('kanban')
    expect(
      contract.AgentHistoryItemSchema.safeParse({ ...item, attempt: { ...f.attempt, kind: 'run' } })
        .success,
    ).toBe(false)
    const detail = {
      ...f.detail,
      unresolvedRunLinks: [{ legacyId: '12', reason: 'no_affirmative_evidence' }],
    }
    expect(contract.TaskDetailSchema.parse(detail).unresolvedRunLinks).toHaveLength(1)
    expect(
      contract.TaskDetailSchema.safeParse({ ...f.detail, unresolvedRunLinks: [{ legacyId: '' }] })
        .success,
    ).toBe(false)
  })
})

describe('model settings (audit5-e)', () => {
  const ref = (n: number) => ({ provider: 'openrouter', model: `m/${n}` })
  const chain = Array.from({ length: 11 }, (_, n) => ref(n))
  test('a fallback chain of any length reads and saves', () => {
    expect(contract.ModelSettingsUpdateSchema.safeParse({ fallbacks: chain }).success).toBe(true)
    const settings = {
      fallbacks: chain,
      fallbacksEditable: true,
      aliases: [],
      speech: {
        stt: { provider: null, model: null },
        tts: { provider: null, model: null, voice: null },
      },
    }
    expect(contract.ModelSettingsSchema.safeParse(settings).success).toBe(true)
  })
  test('speech-to-text can be set back to Automatic', () => {
    expect(
      contract.ModelSettingsUpdateSchema.safeParse({ speech: { stt: { provider: null } } }).success,
    ).toBe(true)
  })
})

test('a summary message part is text only and a room carries its setting', () => {
  const part = { kind: 'summary', coversUntil: 'm1', text: 'Plan B', stale: true }
  expect(contract.MessagePartSchema.parse(part)).toEqual(part)
  expect(contract.MessagePartSchema.safeParse({ ...part, coversUntil: '' }).success).toBe(false)
  expect(contract.MessagePartSchema.safeParse({ ...part, text: 'x'.repeat(16385) }).success).toBe(
    false,
  )
  expect(
    contract.MessageUpdatedSchema.parse({ roomId: 'r', messageId: 'm', parts: [part] }).parts,
  ).toHaveLength(1)
})

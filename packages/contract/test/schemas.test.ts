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
  [
    'NowSnapshotSchema',
    {
      asOfSeq: 0,
      now: f.at,
      paused: false,
      headline: { working: 1, needsYou: 1, text: 'One agent is working. One thing needs you.' },
      lanes: [{ agent: f.agent, blocks: [f.lane] }],
      handoffs: [f.handoff],
      focusApproval: f.approval,
      thread: { roomId: 'room-1', messages: [f.message] },
      madeToday: [
        {
          title: 'Feed',
          ref: { kind: 'task', taskId: 'task-1' },
          files: [{ path: 'a.ts', added: 0, removed: 0 }],
          checks: [{ label: 'Tests pass', agentId: 'builder', ok: true }],
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
        },
      ],
      approvals: { asked: 0, approved: 0, denied: 0, medianWaitSec: null, insight: null },
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
      stats: { runningSec: 1, steps: 1, handoffs: 0, spendUsd: null, eta: null },
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
  ['SecurityStatusSchema', { passwordSet: true }, { passwordSet: 'yes' }],
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
  ['RetryReplyResponseSchema', { messageId: 'reply-2' }, {}],
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

import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { workflowCases } from './workflow-cases.ts'

const orcCap = `orc_${'a'.repeat(43)}`
const orcAttempt = {
  id: 'orc-o1-s1-1',
  kind: 'step',
  stepId: 's1',
  n: 1,
  agentId: 'builder',
  sessionId: 'orc-o1-s1-1',
  state: 'running',
  runId: 'run-1',
  retired: false,
  stopRequestedAt: null,
  stopAcknowledgedAt: null,
  terminatedAt: null,
  evidence: null,
  unknownReason: null,
  spendUsd: null,
  spendComplete: false,
  abandonedAt: null,
}
const orcStep = {
  id: 's1',
  agentId: 'builder',
  instruction: 'Write it',
  after: [],
  replaces: null,
  status: 'admitted',
  disposition: null,
  estimateUsd: 0.5,
  result: null,
  resultRevision: 0,
  gateId: 'g1',
  attemptId: 'orc-o1-s1-1',
  createdAt: '2026-10-06T12:00:00.000Z',
  updatedAt: '2026-10-06T12:00:00.000Z',
}
const orcGate = {
  id: 'g1',
  stepId: 's1',
  requestedBy: 'policy',
  status: 'open',
  payload: {
    agentId: 'builder',
    agentIncarnation: 'inc-1',
    instruction: 'Write it',
    after: [],
    replaces: null,
    estimateUsd: 0.5,
    dependencyRevisions: {},
  },
  payloadHash: 'abc',
  revision: 1,
  note: null,
  createdAt: '2026-10-06T12:00:00.000Z',
  decidedAt: null,
}
const orcInquiry = {
  id: 'q1',
  question: 'Which branch?',
  status: 'open',
  answer: null,
  revision: 1,
  createdAt: '2026-10-06T12:00:00.000Z',
  answeredAt: null,
}
const orcBudget = {
  limitUsd: 5,
  settledUsd: 1,
  provisionalUsd: 0.5,
  reservedUsd: 0.5,
  remainingUsd: 3,
  unknownSpend: false,
  complete: false,
}
const orcDetail = {
  ...f.orchestrationSummary,
  goal: 'Ship it',
  allowedAgents: ['builder'],
  plan: ['Write', 'Review'],
  maxSteps: 12,
  maxConcurrentSteps: 2,
  deadlineAt: null,
  leadTurnEstimateUsd: 0.25,
  stepEstimateUsd: 0.5,
  budget: orcBudget,
  stepsList: [orcStep],
  attempts: [orcAttempt],
  gates: [orcGate],
  inquiries: [orcInquiry],
  finish: null,
  unconfirmed: [],
  cancelFence: [],
  waiverAt: null,
  acknowledgedAt: '2026-10-06T12:00:00.000Z',
  endReason: null,
  storage: { reserveBytes: 1000, storedBytes: 10 },
}
const orcPolicyId = 'a'.repeat(64)
const orcWorker = {
  agentId: 'coder',
  runtime: 'claude-code',
  readiness: 'ready',
  detail: null,
  policyId: orcPolicyId,
  reach: 'Reads and edits files in /work.',
  reachBeyondWorkspace: false,
}
const orcPreflight = {
  ok: true,
  checks: [{ id: 'listener', status: 'ok', message: 'ok' }],
  workers: [orcWorker],
  gatePolicyNotes: { 'every-step': 'a', 'lead-asks': 'b', none: 'c' },
  acknowledgementText: contract.ORCH_ACKNOWLEDGEMENT_TEXT,
  defaults: {
    maxSteps: 12,
    maxLeadTurns: 20,
    maxConcurrentSteps: 2,
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
    codingSteps: 10,
  },
  reserveBytes: 100,
}
const orcTool = { capability: orcCap, commandId: 'c-1' }
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
const xtc = `xtc_${'a'.repeat(43)}`
const job = {
  id: 'job_1',
  roomId: 'room-1',
  title: 'Activity feed',
  state: 'working',
  holderAgentId: 'builder',
  isDefault: false,
  exchangeBudget: 8,
  jobTurnLimit: 40,
  unread: 2,
  activeAgents: ['builder'],
  lastMessageAt: '2026-10-24T00:00:00.000Z',
  messageCount: 4,
  summary: 'Get the activity feed streaming',
  source: null,
  reportBack: null,
  spendCapUsd: null,
  recipe: null,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
}
const exchange = {
  id: 'xch_1',
  jobId: 'job_1',
  roomId: 'room-1',
  kind: 'review',
  parentId: null,
  from: 'builder',
  to: 'reviewer',
  state: 'live',
  round: 1,
  turnsUsed: 1,
  budget: 8,
  outcome: null,
  endedReason: null,
  pause: { reason: 'exchange_budget', options: ['more_turns', 'lead_decides', 'step_in', 'stop'] },
  queuedBehind: null,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
}
// PLAN 11.1b: jobs, exchanges and agent actions.
const exchangeCases = [
  ['ExchangeActionKindSchema', 'send_back', 'merge'],
  [
    'ExchangeActionSchema',
    { action: 'review', to: 'reviewer', note: 'Check the cursor' },
    { action: 'approve', note: 'ok', extra: 1 },
  ],
  [
    'BridgeExchangeActionRequestSchema',
    { capability: xtc, commandId: 'c-1', action: { action: 'reply', text: 'Yes' } },
    { capability: 'orc_short', commandId: 'c-1', action: { action: 'reply', text: 'Yes' } },
  ],
  [
    'ExchangeReceiptSchema',
    { status: 'staged', commandId: 'c-1', action: 'handoff', message: 'Will go to builder' },
    { status: 'applied', commandId: 'c-1', action: 'handoff', message: 'x' },
  ],
  ['JobSchema', job, { ...job, state: 'paused' }],
  ['ExchangeKindSchema', 'ask', 'approve'],
  ['ExchangeStateSchema', 'paused_budget', 'paused'],
  ['ExchangeSchema', exchange, { ...exchange, round: 0 }],
  ['JobsResponseSchema', { asOfSeq: 1, items: [job] }, { items: [job] }],
  ['JobCreateRequestSchema', { title: 'Release notes' }, { title: '  ' }],
  ['ExchangesResponseSchema', { asOfSeq: 1, items: [exchange] }, { asOfSeq: 1, items: [job] }],
  ['ExchangePauseReasonSchema', 'asker_gone', 'tired'],
  [
    'TeamRoomResponseSchema',
    { asOfSeq: 1, room: f.room, jobs: [job] },
    { asOfSeq: 1, jobs: [job] },
  ],
  ['DirectChatsResponseSchema', { asOfSeq: 1, room: null, chats: [] }, { asOfSeq: 1, chats: [] }],
  ['ChatCreateRequestSchema', { title: 'Websockets or SSE' }, { title: '' }],
  ['ShareToJobRequestSchema', { jobId: 'job_1' }, { jobId: '' }],
  [
    'RoomPinSchema',
    { messageId: 'm1', text: 'Cursor is (created_at, id).', pinnedAt: '2026-10-24T00:00:00.000Z' },
    { messageId: 'm1' },
  ],
  ['RoomPinsResponseSchema', { items: [] }, { items: [{}] }],
  ['RoomPinsChangedSchema', { roomId: 'r1' }, {}],
  ['TriggerMappingSchema', { ref: 'ticket.id', title: 'ticket.title' }, { ref: 'ticket..id' }],
  [
    'ReportBackSchema',
    { mode: 'fixed', tool: 'add_comment', args: '{"id":"{{source.ref}}"}' },
    { mode: 'fixed' },
  ],
  [
    'TriggerSchema',
    {
      id: 'trg_1',
      name: 'New ticket',
      app: 'Tickets app',
      mapping: { ref: 'ticket.id' },
      template: 'Fix {{ticket.title}}',
      reportBack: { mode: 'off' },
      url: null,
      sample: null,
      lastCalledAt: null,
      createdAt: '2026-10-24T00:00:00.000Z',
    },
    { id: 'trg_1' },
  ],
  [
    'TriggerCreateRequestSchema',
    { name: 'x', app: 'y', mapping: { ref: 'a' }, template: 'z', reportBack: { mode: 'off' } },
    { name: 'x' },
  ],
  ['TriggerUpdateRequestSchema', { name: 'Renamed' }, { other: 1 }],
  ['TriggerSecretSchema', { secret: 'whsec_AAAA' }, { secret: 'plain' }],
  [
    'TriggerCreatedSchema',
    {
      trigger: {
        id: 'trg_1',
        name: 'New ticket',
        app: 'Tickets app',
        mapping: { ref: 'ticket.id' },
        template: 'Fix it',
        reportBack: { mode: 'off' },
        url: null,
        sample: null,
        lastCalledAt: null,
        createdAt: '2026-10-24T00:00:00.000Z',
      },
      secret: 'whsec_AAAA',
    },
    { secret: 's' },
  ],
  ['TriggersResponseSchema', { items: [] }, { items: [{}] }],
  [
    'JobSourceSchema',
    { app: 'Tickets', ref: 'TCK-1', title: null, link: null, triggerId: 'trg_1', missing: [] },
    { app: 'Tickets' },
  ],
  [
    'JobReportBackSchema',
    { state: 'confirmed', tool: 'add_comment', at: null },
    { state: 'done', tool: null, at: null },
  ],
  [
    'ResultChangeLineSchema',
    { text: 'Approved by reviewer', by: 'reviewer', caught: false },
    { text: 'x' },
  ],
  [
    'ResultCardSchema',
    {
      kind: 'preview',
      id: 'p1',
      agentId: 'builder',
      url: 'http://localhost:5173',
      title: null,
      imageUrl: null,
      live: true,
      at: '2026-10-24T00:00:00.000Z',
    },
    { kind: 'code', id: 'x' },
  ],
  [
    'JobResultsSchema',
    { asOfSeq: 1, items: [], screens: [] },
    { asOfSeq: 1, items: [{ kind: 'draft' }], screens: [] },
  ],
  ['ExchangeOptionSchema', 'answer_to_lead', 'shrug'],
  [
    'ExchangeDecisionRequestSchema',
    { option: 'more_turns', turns: 4 },
    { option: 'more_turns', turns: 50 },
  ],
] as const

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
  ['ShapeSchema', 'cloud', 'oval'],
  ['AgentStyleSchema', f.style, { ...f.style, color: '#abc' }],
  ['AgentLookSchema', 'ring', 'chibi'],
  ['PetActivitySchema', 'work', 'dance'],
  ['PetPackManifestSchema', { name: 'Luna', floor: 0.03 }, { floor: 0.5 }],
  ['PackRevSchema', 'r7Kq-2', '../x'],
  [
    'PetPackSchema',
    { rev: 'a1', activities: ['idle', 'work'], name: 'Luna', credits: null, floor: 0 },
    { rev: 'a1', activities: [], name: null, credits: null, floor: 0 },
  ],
  ['AgentStylePatchSchema', { look: 'ring', shape: 'cylinder' }, { look: 'chibi' }],
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
  ['JourneyKindSchema', 'memory_changed', 'memory_text'],
  [
    'JourneyEventSchema',
    { at: '2026-10-09T10:00:00.000Z', kind: 'task_done', label: 'Fix it', ref: 't1' },
    { at: 'yesterday', kind: 'task_done', label: 'Fix it', ref: null },
  ],
  [
    'JourneySchema',
    {
      from: '2026-10-03',
      to: '2026-10-09',
      truncated: false,
      agents: [
        {
          id: 'builder',
          events: [
            {
              at: '2026-10-09T10:00:00.000Z',
              kind: 'memory_changed',
              label: 'Memory file changed',
              ref: null,
            },
          ],
        },
      ],
    },
    { from: '3 Oct', to: '2026-10-09', truncated: false, agents: [] },
  ],
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
  [
    'SubagentSummarySchema',
    {
      status: 'done',
      description: 'Look',
      subagentType: null,
      toolCalls: 1,
      durationMs: 5,
      totalTokens: null,
    },
    {
      status: 'lost',
      description: 'Look',
      subagentType: null,
      toolCalls: 1,
      durationMs: 5,
      totalTokens: null,
    },
  ],
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
  [
    'SecurityStatusSchema',
    { passwordSet: true, origins: [], terminal: false, terminalUnavailable: null },
    { passwordSet: 'yes' },
  ],
  [
    'TerminalTicketSchema',
    { ticket: 't'.repeat(43), expiresAt: '2026-10-09T10:00:00.000Z' },
    { ticket: 'short', expiresAt: '2026-10-09T10:00:00.000Z' },
  ],
  [
    'TerminalSessionSchema',
    {
      id: '6a6f5a54-1a6e-4f4e-8a60-7d7a1b8f4f5a',
      openedAt: '2026-10-09T10:00:00.000Z',
      lastActivityAt: '2026-10-09T10:01:00.000Z',
      address: '192.168.1.5',
      cols: 120,
      rows: 36,
    },
    { id: 'x', cols: 0 },
  ],
  ['TerminalSessionsSchema', { items: [] }, { items: 1 }],
  [
    'TerminalClientFrameSchema',
    { type: 'resize', cols: 80, rows: 24 },
    { type: 'resize', cols: 0, rows: 24 },
  ],
  [
    'TerminalServerFrameSchema',
    { type: 'exit', reason: 'idle', code: null },
    { type: 'exit', reason: 'bored', code: null },
  ],
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
  [
    'AboutSchema',
    {
      version: '1.3.0',
      commit: null,
      schema: 67,
      contract: 1,
      hermes: null,
      node: 'v24.0.0',
      mode: 'fake',
      repository: 'https://github.com/kohz87/score',
      checkout: '/srv/score',
      service: true,
    },
    { version: '1.3.0' },
  ],
  ['UpdateCheckStatusSchema', 'ahead', 'newer'],
  [
    'UpdateCheckSchema',
    {
      checkedAt: '2026-10-14T10:00:00.000Z',
      current: '1.3.0',
      status: 'ahead',
      latest: null,
      message: 'x',
    },
    { checkedAt: 'yesterday', current: '1.3.0', status: 'ahead', latest: null, message: 'x' },
  ],
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
    'LineCommentSchema',
    { path: 'api/events.py', line: 3, text: 'Off by one' },
    { path: 'a\nb', line: 3, text: 'x' },
  ],
  [
    'ResultDraftSchema',
    {
      kind: 'draft',
      id: 'd1',
      agentId: 'builder',
      title: 'Notes',
      target: { kind: 'workspace', path: 'notes.md' },
      at: '2026-10-24T10:00:00.000Z',
    },
    {
      kind: 'draft',
      id: 'd1',
      agentId: 'builder',
      title: 'Notes',
      target: { kind: 'url' },
      at: '2026-10-24T10:00:00.000Z',
    },
  ],
  ['WorkbenchLineSchema', { n: 1, text: 'x', by: null }, { n: 0, text: 'x', by: null }],
  [
    'WorkbenchCommentSchema',
    {
      id: 'rvc_1',
      by: 'reviewer',
      line: null,
      originalLine: 4,
      text: 'Fix',
      outdated: true,
      exchangeId: null,
      kind: 'send_back',
      at: '2026-10-24T10:00:00.000Z',
    },
    {
      id: 'rvc_1',
      by: 'reviewer',
      line: 4,
      originalLine: 4,
      text: 'Fix',
      outdated: false,
      exchangeId: null,
      kind: 'handoff',
      at: '2026-10-24T10:00:00.000Z',
    },
  ],
  [
    'WorkbenchFileSchema',
    {
      path: 'a.py',
      language: 'python',
      exact: true,
      lines: [],
      cursors: [{ agentId: 'builder', line: 2, at: '2026-10-24T10:00:00.000Z' }],
      comments: [],
      editedBy: ['builder'],
      lastEditAt: '2026-10-24T10:00:00.000Z',
    },
    {
      path: '',
      language: null,
      exact: true,
      lines: [],
      cursors: [],
      comments: [],
      editedBy: [],
      lastEditAt: '2026-10-24T10:00:00.000Z',
    },
  ],
  [
    'WorkbenchSchema',
    { asOfSeq: 0, files: [], looseComments: [], drafts: [], screens: [] },
    { asOfSeq: 0, files: [], drafts: [], screens: [] },
  ],
  [
    'RunsOnSchema',
    {
      backend: 'docker',
      raw: 'docker',
      separated: 'partly',
      docker: {
        image: null,
        network: true,
        mountsWorkspace: false,
        runsAsRoot: true,
        extraMounts: 0,
      },
      ssh: null,
      separatedTools: ['Terminal'],
      hostTools: ['MCP servers'],
      notes: [],
      checked: { how: 'live', hermes: '0.21.5', at: '2026-10-24' },
    },
    { backend: 'docker', separated: 'yes' },
  ],
  [
    'RunsOnUpdateSchema',
    { backend: 'ssh', host: 'build-box', user: 'agent', port: 22, keyPath: '/home/me/.ssh/key' },
    { backend: 'ssh', host: '-oProxyCommand=x', user: 'agent' },
  ],
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
    {
      vault: '/v',
      notes: 2,
      gitAvailable: true,
      agentAccess: true,
      memoryNotes: false,
      documents: 1,
      documentBytes: 10,
      moveIssue: { state: 'conflicted', from: 'a.md', to: 'b.md', message: 'm' },
    },
    { vault: '/v', notes: -1, gitAvailable: true, agentAccess: true },
  ],
  [
    'KnowledgeNoteSummarySchema',
    { path: 'a.md', title: 'A', mtime: 'x', lastAuthor: null },
    { path: '', title: 'A', mtime: 'x', lastAuthor: null },
  ],
  [
    'KnowledgeTreeSchema',
    { folders: ['p'], notes: [], documents: [] },
    { folders: 'p', notes: [] },
  ],
  ['KnowledgeDocumentTypeSchema', 'pdf', 'exe'],
  ['KnowledgeTextStatusSchema', 'indexed', 'maybe'],
  [
    'KnowledgeDocumentSummarySchema',
    {
      path: 'a.pdf',
      type: 'pdf',
      size: 10,
      mtime: 'x',
      lastAuthor: 'you',
      versioned: true,
      textStatus: 'indexed',
    },
    { path: 'a.pdf', type: 'exe' },
  ],
  [
    'KnowledgeDocumentSchema',
    {
      path: 'a.zip',
      type: 'zip',
      size: 10,
      mtime: 'x',
      lastAuthor: null,
      versioned: false,
      textStatus: 'none',
      text: '',
      entries: [{ path: 'b.md', size: 3 }],
    },
    { path: 'a.zip', type: 'zip' },
  ],
  ['KnowledgeZipEntrySchema', { path: 'b.md', size: 3 }, { path: 'b.md' }],
  ['KnowledgeUploadConflictSchema', 'keep', 'overwrite'],
  ['KnowledgeHistoryStatusSchema', 'git_unavailable', 'versioned'],
  [
    'KnowledgeUploadResultSchema',
    { path: 'a.pdf', kind: 'document', replaced: false, history: 'not_versioned' },
    { path: 'a.pdf', kind: 'folder', replaced: false },
  ],
  [
    'KnowledgeExistsDetailsSchema',
    { existing: [{ path: 'a.pdf', mtime: 'x', size: 1 }] },
    { existing: [{ path: 'a.pdf' }] },
  ],
  [
    'KnowledgeZipPreviewSchema',
    {
      entries: [{ path: 'a.md', size: 1, action: 'extract', reason: null }],
      more: false,
      extractCount: 1,
    },
    {
      entries: [{ path: 'a.md', size: 1, action: 'maybe', reason: null }],
      more: false,
      extractCount: 1,
    },
  ],
  [
    'KnowledgeUnzipResultSchema',
    {
      folder: 'f',
      written: ['f/a.md'],
      skipped: [{ path: 'x.exe', reason: 'type not supported' }],
      history: 'committed',
    },
    { folder: 'f', written: 'a' },
  ],
  ['KnowledgeFolderRequestSchema', { path: 'f' }, { path: '' }],
  ['KnowledgeExportRequestSchema', { folder: 'f' }, { all: true, folder: 'f' }],
  [
    'KnowledgeExportSummarySchema',
    { files: 2, bytes: 10, label: 'vault' },
    { files: -1, bytes: 10, label: 'vault' },
  ],
  [
    'KnowledgeFromMediaRequestSchema',
    { mediaId: 'm1', path: 'inbox/a.pdf', onConflict: 'ask' },
    { mediaId: '', path: 'inbox/a.pdf' },
  ],
  [
    'KnowledgeFromStagedRequestSchema',
    {
      stagedId: 'A'.repeat(32),
      path: 'inbox/a.zip',
      mode: 'unzip',
      folder: 'inbox/a',
      onConflict: 'ask',
    },
    { stagedId: '../x', path: 'inbox/a.zip', mode: 'keep' },
  ],
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
      versioned: false,
      history: 'not_versioned',
    },
    { path: 'a.md' },
  ],
  ['KnowledgeWriteRequestSchema', { body: 'x', etag: null }, { body: 'x' }],
  [
    'KnowledgeWriteResponseSchema',
    { etag: 'e', path: 'a.md', versioned: false, historyUpdated: true, history: 'not_versioned' },
    { etag: 'e' },
  ],
  [
    'KnowledgeMoveRequestSchema',
    { from: 'a.md', to: 'b.md', updateLinks: true },
    { from: 'a.md', to: 'b.md' },
  ],
  [
    'KnowledgeMoveResponseSchema',
    { path: 'b.md', updatedNotes: 2, skipped: [{ path: 'c.md', reason: 'it changed' }] },
    { path: 'b.md', updatedNotes: 2, skipped: [{ path: 'c.md' }] },
  ],
  [
    'KnowledgeSearchHitSchema',
    { path: 'a.md', title: 'A', snippet: 'x [[y]] z', kind: 'note', type: null },
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
    {
      path: 'a.md',
      title: 'A',
      body: '',
      etag: 'e',
      truncated: false,
      kind: 'note',
      notice: null,
    },
    { path: 'a.md' },
  ],
  [
    'BridgeKnowledgeListResponseSchema',
    { folders: [], notes: [], documents: [], truncated: false },
    { folders: [] },
  ],
  [
    'BridgeKnowledgeWriteResponseSchema',
    { etag: 'e', path: 'a.md', versioned: true, historyUpdated: false, history: 'failed' },
    { etag: 'e' },
  ],
  ['KnowledgeAgentAccessSchema', { enabled: true }, { enabled: 'yes' }],
  [
    'McpAccessSchema',
    {
      agentId: 'builder',
      enabled: true,
      writesEnabled: false,
      hasToken: true,
      tokenCreatedAt: '2026-10-09T10:00:00.000Z',
      available: true,
      url: 'http://127.0.0.1:8740/bridge/mcp',
      command:
        'hermes --profile builder mcp add score --url http://127.0.0.1:8740/bridge/mcp --auth header',
      postsThisHour: 0,
      postLimitPerHour: 30,
    },
    { agentId: 'builder', enabled: 'yes' },
  ],
  ['McpAccessPatchSchema', { enabled: true }, {}],
  [
    'McpTokenIssuedSchema',
    {
      token: `scm_${'a'.repeat(43)}`,
      access: {
        agentId: 'builder',
        enabled: true,
        writesEnabled: false,
        hasToken: true,
        tokenCreatedAt: null,
        available: false,
        url: null,
        command: null,
        postsThisHour: 0,
        postLimitPerHour: 30,
      },
    },
    { token: 'a'.repeat(43), access: {} },
  ],
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
  // PLAN 5.36: compaction and room deletion
  ['CompactRequestSchema', { keepRecent: 3 }, { keepRecent: 0 }],
  ['CompactAcceptedSchema', { commandId: 'c1' }, { commandId: '' }],
  ['SessionSizeSchema', { messages: 4, tokens: 900 }, { messages: -1, tokens: 900 }],
  ['CompactFailureReasonSchema', 'no_answer', 'x'],
  [
    'SessionCompactedSchema',
    {
      commandId: 'c1',
      agentId: 'builder',
      sessionId: 'score-r-builder',
      roomId: 'r',
      status: 'nothing',
      reason: null,
      keepRecent: null,
      before: null,
      after: null,
      memoryNote: 'Memory/builder/2026/10/2026-10-16 x.md',
    },
    { commandId: 'c1', agentId: 'builder', sessionId: 's', status: 'maybe' },
  ],
  ['ContextPartKindSchema', 'mcp', 'other'],
  [
    'ContextPartSchema',
    { kind: 'skills', label: 'Skills', tokens: 10 },
    { kind: 'skills', label: '', tokens: 10 },
  ],
  ['ReadingSourceSchema', 'local_estimate', 'guess'],
  [
    'SessionContextReadingSchema',
    {
      window: 1000,
      used: 10,
      model: 'm',
      source: 'provider_usage',
      autoCompactAt: null,
      parts: [],
    },
    { window: 1000, used: 10, model: 'm', source: 'x', autoCompactAt: null, parts: [] },
  ],
  [
    'SessionContextSchema',
    {
      window: null,
      used: null,
      measuredAt: null,
      model: null,
      source: null,
      parts: null,
      autoCompactAt: null,
      compactions: 0,
    },
    { window: 0 },
  ],
  [
    'SessionContextSnapshotSchema',
    {
      asOfSeq: 3,
      window: null,
      used: null,
      measuredAt: null,
      model: null,
      source: null,
      parts: null,
      autoCompactAt: null,
      compactions: 0,
    },
    { window: null },
  ],
  ['RoomDeleteRequestSchema', { confirm: '#launch' }, { confirm: '' }],
  [
    'RoomDeletePlanSchema',
    { name: '#launch', messages: 3, files: 1, runs: 2, briefs: 0, blocked: null },
    { name: '#launch', messages: 3 },
  ],
  ['RoomDeletedSchema', { id: 'r' }, { id: '' }],
  // PLAN 7.2: coding agents
  ['RuntimeSchema', 'claude-code', 'opencode'],
  ['CostKindSchema', 'estimated', 'free'],
  ['CodingRuntimeSchema', 'codex', 'opencode'],
  ['CodingPermissionSchema', 'workspace-write', 'root'],
  ['CliStateSchema', 'untested_version', 'broken'],
  [
    'CodingRuntimeInfoSchema',
    {
      runtime: 'claude-code',
      label: 'Claude Code',
      state: 'ready',
      version: '2.1.295',
      testedVersions: ['2.1.295'],
      quota: 'Uses your Claude plan quota.',
      message: null,
      unverifiedPermissions: [],
      warning: null,
    },
    { runtime: 'claude-code', label: 'Claude Code', state: 'ready' },
  ],
  [
    'CodingUsageGroupSchema',
    {
      name: 'Gemini Pro',
      fiveHourRemainingPercent: 82,
      fiveHourResets: 'resets in 3h',
      weeklyRemainingPercent: null,
      weeklyResets: null,
    },
    { name: 'Gemini Pro', fiveHourRemainingPercent: 120 },
  ],
  [
    'CodingUsageSchema',
    {
      runtime: 'antigravity',
      fetchedAt: '2026-10-11T00:00:00.000Z',
      groups: [],
      text: 'table',
    },
    { runtime: 'nope', fetchedAt: 'yesterday', groups: [], text: 'x' },
  ],
  [
    'CodingQuotaWindowSchema',
    { name: '5 hours', group: null, usedPercent: 6, resetsAt: '2026-10-16T05:40:00.000Z' },
    { name: 'month', group: null, usedPercent: 6, resetsAt: null },
  ],
  [
    'CodingQuotaSchema',
    {
      runtime: 'codex',
      seenAt: '2026-10-16T05:40:00.000Z',
      source: 'log',
      windows: [{ name: 'week', group: 'Gemini Models', usedPercent: null, resetsAt: null }],
    },
    {
      runtime: 'codex',
      seenAt: '2026-10-16T05:40:00.000Z',
      source: 'log',
      windows: [{ name: 'week', group: null, usedPercent: 101, resetsAt: null }],
    },
  ],
  ['CodingQuotaResponseSchema', { quota: null }, { quota: { runtime: 'codex' } }],
  [
    'CodingModelOptionSchema',
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', description: 'Fast.', efforts: ['low', 'high'] },
    { id: '', name: 'No id' },
  ],
  ['ThemeColorTokenSchema', 'ground', 'agent-jade'],
  ['ThemeColorSchema', 'oklch(0.7 0.1 200 / 0.5)', 'url(https://example.com/x)'],
  ['ThemeAssetRefSchema', 'asset:img/bg.webp', 'asset:img/../../x.svg'],
  ['ThemeAssetPathSchema', 'img/bg.webp', 'img/../../x.svg'],
  [
    'ThemeFontFaceSchema',
    { family: 'Serif', src: 'asset:fonts/s.woff2', weight: '400', style: 'italic' },
    { family: 'Serif', src: 'https://example.com/s.woff2' },
  ],
  ['ThemeDestinationSchema', '/chat', '/admin'],
  ['ThemeNowCardSchema', 'needs-you', 'iframe'],
  ['ThemeIdSchema', 'harbour', 'Harbour!'],
  [
    'ThemeManifestSchema',
    {
      format: 1,
      id: 'harbour',
      name: 'Harbour',
      version: '1.0.0',
      colors: {
        light: { ground: '#eef2f6', 'bubble-own': 'rgb(18 19 26 / 0.9)' },
        dark: { ink: '#f4f6fa' },
      },
      fonts: {
        heading: 'Harbour Serif',
        faces: [
          {
            family: 'Harbour Serif',
            src: 'asset:fonts/serif.woff2',
            weight: '400 700',
            style: 'normal',
          },
        ],
      },
      shape: { radius: 'soft', density: 'airy', elevation: 'floating', surface: 'glass' },
      layout: {
        nav: 'left',
        menu: [{ to: '/chat', label: 'Talk' }, { to: '/now' }, { to: '/settings' }],
        now: {
          columns: 3,
          cards: [
            { card: 'needs-you', span: 1 },
            { card: 'timeline', span: 3 },
          ],
        },
        chat: { messages: 'bubbles' },
      },
      background: { image: 'asset:img/bg.webp', fit: 'cover', dim: 20 },
      views: { user: { shape: { radius: 'round' } } },
    },
    { format: 1, id: 'x', name: 'X', script: 'alert(1)' },
  ],
  ['ThemeSourceSchema', 'custom', 'remote'],
  [
    'ThemeSummarySchema',
    {
      id: 'harbour',
      name: 'Harbour',
      version: '1.0.0',
      author: null,
      description: null,
      source: 'imported',
      updatedAt: '2026-10-17T10:00:00.000Z',
      hasCss: true,
    },
    { id: 'harbour' },
  ],
  [
    'ThemeListSchema',
    {
      items: [
        {
          id: 'harbour',
          name: 'Harbour',
          version: '1.0.0',
          author: null,
          description: null,
          source: 'imported',
          updatedAt: '2026-10-17T10:00:00.000Z',
          hasCss: true,
        },
      ],
      active: 'score',
      mode: 'system',
      resetGeneration: 3,
    },
    { items: [], active: 'score', mode: 'system', resetGeneration: -1 },
  ],
  [
    'ThemeDetailSchema',
    {
      summary: {
        id: 'harbour',
        name: 'Harbour',
        version: '1.0.0',
        author: null,
        description: null,
        source: 'imported',
        updatedAt: '2026-10-17T10:00:00.000Z',
        hasCss: true,
      },
      manifest: { format: 1, id: 'harbour', name: 'Harbour', version: '1.0.0' },
      css: '.now-card { border-radius: 4px; }',
      assets: ['img/bg.webp'],
      licenseFiles: ['OFL.txt'],
      etag: 'e1',
    },
    { manifest: { format: 2, id: 'harbour', name: 'Harbour' } },
  ],
  ['ThemeRevSchema', 'ab12-_Z', 'a b'],
  [
    'ThemeSanitiseReportSchema',
    { dropped: [{ rule: '.approval::after { content: "Approve" }', reason: 'content' }] },
    { dropped: [{ rule: 'x', reason: 'because' }] },
  ],
  [
    'ThemeSaveSchema',
    { manifest: { format: 1, id: 'mine', name: 'Mine', version: '1.0.0' }, css: '', etag: null },
    { manifest: { format: 1, id: 'mine', name: 'Mine' }, css: '', etag: null, extra: true },
  ],
  [
    'ThemeImportResultSchema',
    {
      theme: {
        id: 'harbour',
        name: 'Harbour',
        version: '1.0.0',
        author: null,
        description: null,
        source: 'imported',
        updatedAt: '2026-10-17T10:00:00.000Z',
        hasCss: true,
      },
      report: { dropped: [] },
      detail: {
        summary: {
          id: 'harbour',
          name: 'Harbour',
          version: '1.0.0',
          author: null,
          description: null,
          source: 'imported',
          updatedAt: '2026-10-17T10:00:00.000Z',
          hasCss: true,
        },
        manifest: { format: 1, id: 'harbour', name: 'Harbour', version: '1.0.0' },
        css: '.now-card { border-radius: 4px; }',
        assets: [],
        licenseFiles: [],
        etag: 'e1',
      },
    },
    { theme: null, report: { dropped: [] } },
  ],
  ['LookSettingsSchema', { activeTheme: 'night', mode: 'dark' }, { activeTheme: 'night' }],
  ['ResetGenerationSchema', 0, -1],
  [
    'LookChangedSchema',
    { activeTheme: 'night', mode: 'dark', resetGeneration: 1 },
    { activeTheme: 'night', mode: 'dark', resetGeneration: 1.5 },
  ],
  [
    'CodingModelsResponseSchema',
    { models: [{ id: 'opus', name: 'Opus' }], source: 'aliases' },
    { models: [], source: 'file' },
  ],
  ['CodingRuntimesResponseSchema', { items: [] }, { items: [{ runtime: 'nope' }] }],
  [
    'CodingAgentSchema',
    {
      id: 'coder',
      name: 'Coder',
      role: '',
      instructions: 'Be brief.',
      instructionsEtag: '0123456789abcdef',
      runtime: 'codex',
      workspace: '/work/coder',
      permission: 'read-only',
      model: null,
      style: { color: '#19C39A', shape: 'hexagon' },
      quota: 'Uses your ChatGPT plan quota.',
      quotaFloorPercent: 10,
      cli: { state: 'ready', version: '0.160.1', testedVersions: ['0.160.1'], confirmed: false },
      heldGroups: [{ runId: 'cr_1', pgid: 4242, canRelease: true }],
      createdAt: '2026-10-09T10:00:00.000Z',
    },
    { id: 'coder' },
  ],
  ['CodingAgentsResponseSchema', { items: [] }, { items: 'none' }],
  [
    'CodingBackendSchema',
    {
      kind: 'unit',
      note: 'Runs as a supervised system service.',
      checks: [{ name: 'linger', ok: true, detail: 'linger enabled' }],
      checkedAt: '2026-10-12T10:00:00.000Z',
    },
    { kind: 'container', note: '', checks: [], checkedAt: 'now' },
  ],
  [
    'CodingAgentCreateSchema',
    {
      id: 'coder',
      name: 'Coder',
      role: '',
      instructions: '',
      runtime: 'claude-code',
      permission: 'workspace-write',
      style: { color: '#19C39A', shape: 'hexagon' },
    },
    {
      id: 'Bad Name',
      name: 'Coder',
      runtime: 'claude-code',
      style: { color: '#19C39A', shape: 'hexagon' },
    },
  ],
  ['CodingAgentPatchSchema', { permission: 'read-only' }, { password: 'only a password' }],
  ['QuotaFloorSchema', 0, 51],
  [
    'QuotaHoldViewSchema',
    {
      agentId: 'builder',
      window: '5 hours',
      group: null,
      leftPercent: 6,
      resetsAt: '2026-10-17T13:40:00.000Z',
      state: 'held',
    },
    { agentId: 'builder', window: 'month' },
  ],
  [
    'QuotaDecisionSchema',
    { answer: 'wait', orchestrationRevision: 2 },
    { answer: 'maybe', orchestrationRevision: 2 },
  ],
  ['CodingVersionConfirmSchema', { version: '2.1.295' }, { version: '' }],
  ['CommandIdSchema', 'c-1', 'has space'],
  ['OrchestrationStatusSchema', 'running', 'done'],
  ['GatePolicySchema', 'none', 'always'],
  ['PauseReasonSchema', 'budget', 'bored'],
  ['StepStatusSchema', 'queued', 'waiting'],
  ['AttemptStateSchema', 'unknown', 'lost'],
  ['OwnershipStateSchema', 'draining', 'held'],
  [
    'OrchestrationCreateSchema',
    {
      goal: 'Ship it',
      leadAgentId: 'lead',
      allowedAgents: ['builder'],
      gatePolicy: 'every-step',
      maxSteps: 12,
      maxLeadTurns: 20,
      maxConcurrentSteps: 2,
      leadTurnEstimateUsd: 0.25,
      stepEstimateUsd: 0.5,
      acknowledgement: { text: contract.ORCH_ACKNOWLEDGEMENT_TEXT },
      codingPolicies: { builder: orcPolicyId },
      acknowledgeCodingReach: { policyIds: [orcPolicyId] },
      acceptUnknownCost: ['codex'],
      codingSteps: 5,
    },
    { goal: 'Ship it', leadAgentId: 'lead', allowedAgents: [], acknowledgement: { text: 'x' } },
  ],
  ['PolicyIdSchema', orcPolicyId, 'not-a-hash'],
  ['CostSourceSchema', 'claude-code', 'gemini'],
  ['WorkerReadinessSchema', 'reach_unverifiable', 'fine'],
  ['CodingReachAcknowledgementSchema', { policyIds: [orcPolicyId] }, { policyIds: ['x'] }],
  ['CodingWorkerPreflightSchema', orcWorker, { ...orcWorker, runtime: 'antigravity' }],
  [
    'PolicyRemapDecisionSchema',
    { agentId: 'builder', policyId: orcPolicyId, orchestrationRevision: 2 },
    { agentId: 'builder', policyId: 'x', orchestrationRevision: 2 },
  ],
  ['PreflightCheckSchema', { id: 'journal', status: 'ok', message: 'ok' }, { id: 'x' }],
  ['PreflightSchema', orcPreflight, { ok: true }],
  ['BudgetViewSchema', orcBudget, { limitUsd: 5 }],
  ['AttemptViewSchema', orcAttempt, { id: 'x' }],
  ['StepViewSchema', orcStep, { id: 's1' }],
  ['GateViewSchema', orcGate, { id: 'g1' }],
  ['InquiryViewSchema', orcInquiry, { id: 'q1' }],
  ['NeedsYouSchema', { kind: 'gate', gateId: 'g1', stepId: 's1' }, { kind: 'gate' }],
  ['OrchestrationSummarySchema', f.orchestrationSummary, { id: 'x' }],
  ['OrchEventKindSchema', 'command', 'nope'],
  [
    'OrchEventSchema',
    {
      id: 'cmd:a1:c1',
      at: f.at,
      kind: 'command',
      stepId: 's1',
      attemptId: 'a1',
      tool: 'orch.assign',
      verdict: 'accepted',
      code: null,
      summary: 'Assigned s1',
    },
    { id: '' },
  ],
  ['OrchestrationEventsSchema', { asOfSeq: 1, events: [] }, { events: [] }],
  ['OrchestrationListSchema', { asOfSeq: 1, items: [f.orchestrationSummary] }, { items: [] }],
  ['OrchestrationDetailSchema', orcDetail, { id: 'x' }],
  ['OrchestrationSnapshotSchema', { asOfSeq: 1, orchestration: orcDetail }, { asOfSeq: 1 }],
  ['FenceItemSchema', f.globalFence.items[0], { kind: 'weird' }],
  ['GlobalFenceSchema', f.globalFence, { fenced: true }],
  [
    'GateDecisionSchema',
    { decision: 'approve', expectedRevision: 1, orchestrationRevision: 2 },
    { decision: 'maybe', expectedRevision: 1, orchestrationRevision: 2 },
  ],
  [
    'InquiryAnswerSchema',
    { answer: 'main', expectedRevision: 1, orchestrationRevision: 2 },
    { answer: '', expectedRevision: 1, orchestrationRevision: 2 },
  ],
  [
    'LimitsDecisionSchema',
    {
      budgetUsd: 10,
      codingSteps: 20,
      acceptUnknownCost: { add: ['codex'], remove: ['hermes'] },
      orchestrationRevision: 2,
    },
    { orchestrationRevision: 2 },
  ],
  ['RunControlSchema', { orchestrationRevision: 2 }, { orchestrationRevision: 0 }],
  [
    'RemapDecisionSchema',
    {
      agentId: 'builder',
      frozenIncarnation: 'inc-a',
      currentIncarnation: 'inc-b',
      orchestrationRevision: 2,
      acknowledge: true,
    },
    {
      agentId: 'builder',
      frozenIncarnation: 'inc-a',
      currentIncarnation: 'inc-b',
      orchestrationRevision: 2,
      acknowledge: false,
    },
  ],
  [
    'WaiverDecisionSchema',
    { orchestrationRevision: 2, acknowledge: true },
    { orchestrationRevision: 2, acknowledge: false },
  ],
  [
    'AbandonDecisionSchema',
    { attemptIds: ['a1'], orchestrationRevision: 2, acknowledge: true },
    { attemptIds: [], orchestrationRevision: 2, acknowledge: true },
  ],
  [
    'FenceLiftSchema',
    { expectedRevision: 2, reviewed: true },
    { expectedRevision: 2, reviewed: false },
  ],
  [
    'OrchestrationCreatedSchema',
    { orchestration: f.orchestrationSummary, preflight: orcPreflight },
    { orchestration: f.orchestrationSummary },
  ],
  ['OrchPlanArgsSchema', { ...orcTool, entries: ['one'] }, { ...orcTool, entries: [''] }],
  [
    'OrchAssignArgsSchema',
    { ...orcTool, agent: 'builder', instruction: 'Do it' },
    { ...orcTool, agent: 'builder' },
  ],
  ['OrchCancelArgsSchema', { ...orcTool, stepId: 's1' }, { ...orcTool }],
  ['OrchAskArgsSchema', { ...orcTool, question: 'Why?' }, { ...orcTool, question: '' }],
  ['OrchRequestApprovalArgsSchema', { ...orcTool, stepId: 's1' }, { ...orcTool }],
  ['OrchNoteArgsSchema', { ...orcTool, text: 'Working' }, { ...orcTool, text: '' }],
  [
    'OrchFinishArgsSchema',
    { ...orcTool, outcome: 'success', summary: 'Done' },
    { ...orcTool, outcome: 'meh', summary: 'Done' },
  ],
  ['OrchReceiptArgsSchema', orcTool, { capability: 'orc_short', commandId: 'c-1' }],
  ['OrchReceiptSchema', { status: 'ok' }, { status: 'maybe' }],
  ...workflowCases,
  ...exchangeCases,
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

test('Knowledge notes may be 8 MiB; embedded images are 1.5 MiB and never SVG (PLAN 6.8)', () => {
  expect(contract.KNOWLEDGE_NOTE_MAX_BYTES).toBe(8 * 1024 * 1024)
  expect(contract.KNOWLEDGE_IMAGE_MAX_BYTES).toBe(1.5 * 1024 * 1024)
  expect([...contract.KNOWLEDGE_IMAGE_TYPES]).toEqual([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])
  const write = (body: string) =>
    contract.KnowledgeWriteRequestSchema.safeParse({ body, etag: null })
  expect(write('a'.repeat(contract.KNOWLEDGE_NOTE_MAX_BYTES)).success).toBe(true)
  expect(write('a'.repeat(contract.KNOWLEDGE_NOTE_MAX_BYTES + 1)).success).toBe(false)
})

// PLAN 8.8: an instructions edit names the text it started from, and the text is bounded.
test('CodingAgentPatchSchema: instructions need their etag and stay within the limit', () => {
  const patch = contract.CodingAgentPatchSchema
  expect(patch.safeParse({ instructions: 'Be bold.', instructionsEtag: 'e1' }).success).toBe(true)
  expect(patch.safeParse({ instructions: 'Be bold.' }).success).toBe(false)
  expect(patch.safeParse({ instructionsEtag: 'e1' }).success).toBe(false)
  expect(patch.safeParse({ role: 'Builder' }).success).toBe(true)
  const text = (length: number) => ({ instructions: 'x'.repeat(length), instructionsEtag: 'e1' })
  expect(patch.safeParse(text(contract.CODING_INSTRUCTIONS_MAX)).success).toBe(true)
  expect(patch.safeParse(text(contract.CODING_INSTRUCTIONS_MAX + 1)).success).toBe(false)
  expect(contract.CODING_INSTRUCTIONS_MAX).toBe(8000)
})

test('the colour tokens a theme may set are colours: the halo sizes are not on the list', () => {
  // `--halo-ring` and `--halo-glow` are px sizes in tokens.css; a colour there would break the running-step halo.
  expect(contract.THEME_COLOR_TOKENS).not.toContain('halo-glow')
  expect(contract.THEME_COLOR_TOKENS).not.toContain('halo-ring')
  for (const token of ['halo-glow', 'halo-ring'])
    expect(
      contract.ThemeManifestSchema.safeParse({
        format: 1,
        id: 'x',
        name: 'X',
        colors: { light: { [token]: '#ffffff' } },
      }).success,
    ).toBe(false)
})

test('C1: a Watch frame may carry the Agent call id its sub-agent step ran under', () => {
  const sub = { ...f.watch, parentCallId: 'toolu_agent_1' }
  expect(contract.WatchFrameSchema.parse(sub)).toHaveProperty('parentCallId', 'toolu_agent_1')
  expect(contract.WatchFrameSchema.parse(f.watch)).not.toHaveProperty('parentCallId')
  expect(contract.WatchFrameSchema.safeParse({ ...f.watch, parentCallId: '' }).success).toBe(false)
})

test('C4: a theme save may carry assets, keep and licences, and nothing unsafe', () => {
  const base = { manifest: { format: 1, id: 'mine', name: 'Mine' }, css: '', etag: 'abc' }
  const ok = contract.ThemeSaveSchema.safeParse({
    ...base,
    assets: { 'img/a.png': 'iVBORw0KGgo=' },
    keep: ['fonts/f.woff2'],
    licenses: { 'OFL.txt': 'text' },
  })
  expect(ok.success).toBe(true)
  for (const extra of [
    { assets: { 'img/a.svg': 'iVBORw0KGgo=' } },
    { assets: { '../a.png': 'iVBORw0KGgo=' } },
    { assets: { 'img/a.png': 'not base64!' } },
    { assets: { 'img/a.png': 'abc' } },
    { keep: ['css/x.png'] },
    { licenses: { 'NOTICE.txt': 'x' } },
  ])
    expect(contract.ThemeSaveSchema.safeParse({ ...base, ...extra }).success).toBe(false)
})

// Third gate, finding 5: a menu label that shows nothing would blank a destination (Settings included).
describe('third gate 5: manifest menu labels need a visible character', () => {
  const manifest = (label: string) => ({
    format: 1,
    id: 'x',
    name: 'X',
    layout: { menu: [{ to: '/settings', label }] },
  })
  const accepted = (label: string) =>
    contract.ThemeManifestSchema.safeParse(manifest(label)).success

  test.each([
    ['a space', ' '],
    ['several spaces', '     '],
    ['a tab and a newline', '\t\n'],
    ['a no-break space', ' '],
    ['an ideographic space', '　'],
    ['a zero width space', '​'],
    ['zero width non-joiner and joiner', '‌‍'],
    ['left-to-right and right-to-left marks', '‎‏'],
    ['a word joiner', '⁠'],
    ['a byte order mark', '﻿'],
    ['a soft hyphen', '­'],
    ['a bidi override and its end', '‮‬'],
    ['an isolate', '⁦⁩'],
    ['invisible math operators', '⁡⁤'],
    ['a Mongolian vowel separator', '᠎'],
    ['a combining grapheme joiner', '͏'],
    ['variation selectors', '️︀'],
    ['a braille blank', '⠀'],
    ['a Hangul filler', 'ㅤᅟᅠﾠ'],
    ['a tag space', '\u{e0020}'],
    ['a lone combining mark', '́'],
    ['a control character', '\u0007'],
    ['an Arabic letter mark', '؜'],
    ['everything mixed', ' ​⁠﻿　 '],
  ])('%s is refused', (_name, label) => {
    expect(accepted(label)).toBe(false)
  })

  test('labels with words (and wide, accented, emoji or symbol-only ones) are accepted', () => {
    for (const label of [
      'Home',
      ' Home ',
      'Ho​me',
      'é',
      'ホーム',
      'تنظيم',
      '⚙',
      '🛠',
      '•',
      '1',
      'á',
    ])
      expect(accepted(label), JSON.stringify(label)).toBe(true)
  })

  test('hasVisibleCharacter says the same', () => {
    expect(contract.hasVisibleCharacter(' ​')).toBe(false)
    expect(contract.hasVisibleCharacter(' x ')).toBe(true)
  })
})

test('PLAN 10.2: a style without look or pack (stored before 10.2) still parses; a client patch cannot set the pack', () => {
  const old = contract.AgentStyleSchema.parse({ color: '#6B4EFF', shape: 'circle-dot' })
  expect(old.look).toBeUndefined()
  expect(old.pack).toBeUndefined()
  const patch = contract.AgentStylePatchSchema.parse({ look: 'ring', pack: { rev: 'x' } })
  expect(patch).toEqual({ look: 'ring' })
})

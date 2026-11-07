import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'

const orcCap = `orc_${'a'.repeat(43)}`

export const orcAttempt = {
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

export const orcStep = {
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

export const orcGate = {
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

export const orcInquiry = {
  id: 'q1',
  question: 'Which branch?',
  status: 'open',
  answer: null,
  revision: 1,
  createdAt: '2026-10-06T12:00:00.000Z',
  answeredAt: null,
}

export const orcBudget = {
  limitUsd: 5,
  settledUsd: 1,
  provisionalUsd: 0.5,
  reservedUsd: 0.5,
  remainingUsd: 3,
  unknownSpend: false,
  complete: false,
}

export const orcDetail = {
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

export const orcPolicyId = 'a'.repeat(64)

export const orcWorker = {
  agentId: 'coder',
  runtime: 'claude-code',
  readiness: 'ready',
  detail: null,
  policyId: orcPolicyId,
  reach: 'Reads and edits files in /work.',
  reachBeyondWorkspace: false,
}

export const orcPreflight = {
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

export const orcTool = { capability: orcCap, commandId: 'c-1' }

export const rule = { id: 'SQL DROP', label: 'SQL DROP', pattern: 'SQL DROP', readOnly: false }

export const rules = {
  mode: 'smart',
  goAhead: [rule],
  askMe: [],
  never: [],
  drift: [{ agentId: 'builder', differs: false }],
}

export const provider = {
  id: 'openrouter',
  label: 'OpenRouter',
  status: 'connected',
  detail: 'API key (1)',
  usedBy: ['lead'],
}

export const toolServer = { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' }

export const watchMarker = { seq: 1, at: '2026-10-08T21:30:00.000Z', kind: 'command' }

export const watchResponse = {
  asOfSeq: 1,
  agent: f.agent,
  live: true,
  sessionId: 'sess-1',
  frames: [f.watch],
  markers: [watchMarker],
  gaps: [{ from: watchMarker.at, to: null, reason: 'SSE replay truncated' }],
}

export const watchOverviewItem = {
  agent: f.agent,
  thumbnail: null,
  status: 'Working',
  live: true,
  surface: 'terminal',
}

export const searchHit = {
  messageId: 'm1',
  roomId: 'room-1',
  roomName: '#contract',
  author: { kind: 'you' },
  createdAt: f.at,
  snippet: 'a [[hit]] here',
}

export const shareCreated = { id: 'share-1', url: 'https://score.test/s/abc', expiresAt: f.later }

export const shareSummary = {
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

export const outsideSession = {
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

export const hash = 'a'.repeat(64)

export const createInput = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds',
  style: f.style,
  model: 'm',
}

export const createRequest = { ...createInput, previewHash: hash }

export const preview = {
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

export const operation = {
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

export const xtc = `xtc_${'a'.repeat(43)}`

export const job = {
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
export const exchange = {
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

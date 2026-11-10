// Decision 173: subagents, an agent's own throwaway helpers.
const row = {
  id: 'child-1',
  jobId: 'job_1',
  agentId: 'lead',
  goal: 'Read the feed API',
  state: 'running',
  waitingOnYou: false,
  startedAt: '2026-11-09T10:00:00.000Z',
  endedAt: null,
  costUsd: null,
  tokens: null,
}
const limits = { enabled: true, maxConcurrent: null, maxTotal: 20, used: 3 }
const ceiling = {
  agentId: 'lead',
  control: 'limits',
  enabled: true,
  maxConcurrent: 4,
  model: null,
  maxIterations: 50,
  timeoutSeconds: null,
}

export const subagentCases = [
  [
    'SubagentSetupAgentSchema',
    { agentId: 'lead', inline: true, guard: false },
    { agentId: 'lead' },
  ],
  [
    'SubagentSetupSchema',
    { agents: [{ agentId: 'lead', inline: false, guard: true }] },
    { agents: [{ agentId: 'lead' }] },
  ],
  ['ApplySubagentSetupSchema', { agentIds: ['lead'] }, { agentIds: [] }],
  ['JobSubagentsSchema', limits, { ...limits, maxTotal: 0 }],
  ['JobSubagentsRequestSchema', { enabled: false, maxConcurrent: null }, { maxConcurrent: 99 }],
  ['SubagentRowSchema', row, { ...row, state: 'paused' }],
  ['SubagentRowsResponseSchema', { asOfSeq: 1, items: [row] }, { items: [row] }],
  [
    'SubagentsChangedSchema',
    { jobId: 'job_1', roomId: 'room-1', subagents: limits },
    { jobId: 'job_1', roomId: 'room-1' },
  ],
  ['SubagentControlSchema', 'on_off', 'sometimes'],
  ['AgentSubagentsSchema', ceiling, { ...ceiling, control: 'sometimes' }],
  ['AgentSubagentsRequestSchema', { maxConcurrent: 2, model: null }, { model: '-oops' }],
  // Decision 178: effort per chat.
  [
    'ChatEffortSchema',
    { roomId: 'room-1', agentId: 'builder', effort: 'high' },
    { roomId: 'room-1', agentId: 'builder', effort: 'High!' },
  ],
  ['ChatEffortsResponseSchema', { items: [] }, { items: [{ roomId: 'room-1' }] }],
  ['ChatEffortRequestSchema', { effort: null }, { effort: 'high', extra: 1 }],
  [
    'AgentEffortsSchema',
    {
      agentId: 'builder',
      own: null,
      levels: ['low'],
      chats: [{ roomId: 'r', roomName: 'Team', jobTitle: null, effort: 'max' }],
    },
    { agentId: 'builder', own: null, levels: ['low'] },
  ],
  [
    'EffortChangedSchema',
    { roomId: 'r', agentId: 'builder', effort: null, reason: 'model' },
    { roomId: 'r', agentId: 'builder', effort: null, reason: 'time' },
  ],
] as const

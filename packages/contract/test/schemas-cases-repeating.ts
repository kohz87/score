// Decision 183: Tasks › Repeating and Tasks › Recipes (contract section 22).
const job = {
  id: 'builder:a1',
  title: 'Morning summary',
  schedule: '0 8 * * *',
  description: 'Sum up yesterday.',
  lastRunAt: null,
  enabled: true,
  model: null,
  agentId: 'builder',
  nextRunAt: '2026-11-11T00:00:00.000Z',
  provider: null,
  deliverTo: { roomId: 'r', roomName: 'Team room' },
}
const schedule = {
  workflowId: 'wf-1',
  recipeName: 'Release notes',
  schedule: '0 16 * * 5',
  timezone: 'Asia/Singapore',
  roomId: 'r',
  roomName: '#release',
  enabled: true,
  nextRunAt: null,
  lastRun: { at: '2026-11-07T08:00:00.000Z', outcome: 'missed', briefId: null, reason: null },
}

export const repeatingCases = [
  ['ScheduleTextSchema', 'every 2h', 'every two hours'],
  ['TimeZoneSchema', 'America/Argentina/Buenos_Aires', 'Mars/Base One'],
  ['DeliverToSchema', null, { roomId: '' }],
  [
    'PinnedModelSchema',
    { model: 'deep-model', provider: null },
    { model: 'two words', provider: null },
  ],
  ['RepeatingJobSchema', job, { ...job, agentId: undefined }],
  ['RepeatingJobsResponseSchema', { items: [job], unreadable: ['lead'] }, { items: [job] }],
  [
    'CreateRepeatingJobSchema',
    {
      title: 'Morning',
      schedule: '0 8 * * 1-5',
      prompt: 'Sum up.',
      timezone: 'UTC',
      deliverTo: 'r',
    },
    { title: 'Morning', schedule: 'tomorrow', prompt: 'Sum up.' },
  ],
  ['PatchRepeatingJobSchema', { model: null, deliverTo: null }, { extra: 1 }],
  ['MoveRepeatingJobSchema', { agentId: 'reviewer' }, { agentId: 'reviewer', extra: 1 }],
  ['MovedRepeatingJobSchema', { job, leftBehind: null }, { job }],
  [
    'RecipeScheduleSchema',
    schedule,
    { ...schedule, lastRun: { ...schedule.lastRun, outcome: 'late' } },
  ],
  ['RecipeSchedulesResponseSchema', { items: [schedule] }, { items: [{}] }],
  [
    'RecipeScheduleRequestSchema',
    { schedule: '0 16 * * 5', timezone: 'Asia/Singapore', roomId: 'r', enabled: true },
    { schedule: '0 16 * * 5', timezone: 'Asia/Singapore', roomId: 'r' },
  ],
  [
    'AgentAssignedSchema',
    {
      agentId: 'builder',
      repeating: [job],
      recipeSteps: [
        { workflowId: 'wf-1', recipeName: 'Release notes', stepLabel: 'Draft', schedule: null },
      ],
    },
    { agentId: 'builder', repeating: [] },
  ],
] as const

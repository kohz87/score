import * as contract from '../src/index.ts'

export const modelConfigCases = [
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
      effort: 'high',
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
    { fallbacks: [], effort: null, speech: { tts: { voice: 'en-US-x' } } },
    { effort: 'ultra' },
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
] as const satisfies ReadonlyArray<readonly [keyof typeof contract, unknown, unknown]>

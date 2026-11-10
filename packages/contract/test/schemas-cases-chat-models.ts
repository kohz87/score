// Decision 182: model per chat (contract section 21).
const chosen = {
  roomId: 'r',
  agentId: 'builder',
  model: 'example-large',
  provider: 'demo',
  label: 'deep',
}

export const chatModelCases = [
  ['ChatModelNameSchema', 'upstage/solar-mini4:free', '-rm -rf'],
  ['ChatModelSchema', chosen, { ...chosen, model: 'two words' }],
  ['ChatModelsResponseSchema', { asOfSeq: 1, items: [chosen] }, { items: [] }],
  ['ChatModelRequestSchema', { model: 'deep' }, { model: 'deep', extra: 1 }],
  [
    'ChatModelChangeSchema',
    { roomId: 'r', agentId: 'builder', current: null, replaced: chosen },
    { roomId: 'r', agentId: 'builder', current: null },
  ],
  [
    'AgentChatModelsSchema',
    {
      agentId: 'builder',
      chats: [
        {
          roomId: 'r',
          roomName: 'Team',
          roomKind: 'direct',
          jobTitle: null,
          model: 'm',
          label: 'm',
        },
      ],
    },
    { agentId: 'builder' },
  ],
  [
    'ModelChangedSchema',
    { roomId: 'r', agentId: 'builder', model: null, label: null, reason: 'member' },
    { roomId: 'r', agentId: 'builder', model: null, label: null, reason: 'model' },
  ],
  ['RoutinesPinnedSchema', { pinned: ['builder:a1'] }, { pinned: [''] }],
] as const

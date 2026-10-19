import type { AgentSummary, Approval, Message } from '@score/contract'
import { expect, test } from 'vitest'
import { moodText, newHandoff, stageMembers, stageMoods, type StageInput } from './stage-mood.ts'

const style = { color: '#6B4EFF', shape: 'circle-dot' as const }
const agent = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style,
  status: 'idle',
  activity: null,
  model: null,
  served: true,
  ...extra,
})
const agents = ['lead', 'builder', 'reviewer', 'designer'].map((id) => agent(id))

function message(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    roomId: 'room-1',
    author: { kind: 'agent', agentId: 'builder' },
    to: [],
    parts: [{ kind: 'text', text: 'hello' }],
    createdAt: '2026-10-19T10:00:00.000Z',
    streaming: false,
    refs: [],
    ...extra,
  }
}

function approval(extra: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    origin: 'score-run',
    phase: 'human_pending',
    status: 'pending',
    actionable: true,
    linkedTo: null,
    agentId: 'builder',
    title: 'Run a command',
    command: 'pnpm add ws',
    cwd: null,
    description: '',
    choices: ['once', 'deny'],
    createdAt: '2026-10-19T10:00:00.000Z',
    expiresAt: null,
    decision: null,
    delivery: 'none',
    blocking: null,
    refs: [{ kind: 'room', roomId: 'room-1' }],
    ...extra,
  }
}

const base: StageInput = {
  roomId: 'room-1',
  members: agents,
  messages: [],
  typing: {},
  approvals: [],
}

test('a room with nothing going on rests', () => {
  expect(stageMoods(base)).toEqual({
    lead: 'rest',
    builder: 'rest',
    reviewer: 'rest',
    designer: 'rest',
  })
})

test('a pending, actionable approval for this room is "waiting for you", and it wins over working', () => {
  const moods = stageMoods({
    ...base,
    messages: [message('m1', { streaming: true })],
    approvals: [approval()],
  })
  expect(moods.builder).toBe('needs')
})

test('an approval tied to the room by a card message in it counts, one for another room or already decided does not', () => {
  const card = message('approval:approval-1', {
    parts: [{ kind: 'approval', approvalId: 'approval-1' }],
  })
  expect(
    stageMoods({ ...base, messages: [card], approvals: [approval({ refs: [] })] }).builder,
  ).toBe('needs')
  expect(
    stageMoods({
      ...base,
      approvals: [approval({ refs: [{ kind: 'room', roomId: 'room-2' }] })],
    }).builder,
  ).toBe('rest')
  expect(stageMoods({ ...base, approvals: [approval({ actionable: false })] }).builder).toBe('rest')
  expect(stageMoods({ ...base, approvals: [approval({ status: 'approved' })] }).builder).toBe(
    'rest',
  )
})

test('a reply with text or a tool call in flight is working', () => {
  expect(stageMoods({ ...base, messages: [message('m1', { streaming: true })] }).builder).toBe(
    'work',
  )
  const tool = message('m2', {
    streaming: true,
    parts: [{ kind: 'tool', tool: 'shell', args: '', result: null, status: 'running' }],
  })
  expect(stageMoods({ ...base, messages: [tool] }).builder).toBe('work')
  // A finished reply is not work any more; a streaming message of someone outside the room is ignored.
  expect(stageMoods({ ...base, messages: [message('m3')] }).builder).toBe('rest')
  expect(
    stageMoods({
      ...base,
      messages: [message('m4', { streaming: true, author: { kind: 'agent', agentId: 'ghost' } })],
    }).builder,
  ).toBe('rest')
})

test('typing with text is working; typing without text, or an empty or thought-only reply, is thinking', () => {
  expect(stageMoods({ ...base, typing: { lead: 'is outlining the next steps' } }).lead).toBe('work')
  expect(stageMoods({ ...base, typing: { lead: '' } }).lead).toBe('think')
  expect(
    stageMoods({ ...base, messages: [message('m1', { streaming: true, parts: [] })] }).builder,
  ).toBe('think')
  expect(
    stageMoods({
      ...base,
      messages: [message('m1', { streaming: true, parts: [{ kind: 'thinking', text: 'hm' }] })],
    }).builder,
  ).toBe('think')
  // The stage reads the room's live state, never `Room.activeAgents`.
  expect(stageMoods({ ...base }).reviewer).toBe('rest')
  // Text that has started beats a bare typing notice.
  expect(
    stageMoods({
      ...base,
      typing: { builder: '' },
      messages: [message('m1', { streaming: true })],
    }).builder,
  ).toBe('work')
})

test('paused and offline agents sleep, unless they are waiting for you', () => {
  const sleepy = [agent('builder', { status: 'paused' }), agent('lead', { status: 'offline' })]
  expect(stageMoods({ ...base, members: sleepy })).toEqual({ builder: 'sleep', lead: 'sleep' })
  expect(stageMoods({ ...base, members: sleepy, approvals: [approval()] }).builder).toBe('needs')
  // A stale streaming reply does not keep a paused agent "working".
  expect(
    stageMoods({ ...base, members: sleepy, messages: [message('m1', { streaming: true })] })
      .builder,
  ).toBe('sleep')
})

test('the screen-reader words for each mood', () => {
  expect(moodText('rest')).toBe('resting')
  expect(moodText('think')).toBe('thinking')
  expect(moodText('work')).toBe('working')
  expect(moodText('needs')).toBe('waiting for you')
  expect(moodText('sleep')).toBe('paused')
})

test('members are the room’s members plus the lead, in order, without removed or unknown agents', () => {
  const roster = [
    ...agents,
    agent('gone', {
      lifecycle: {
        state: 'removed',
        incarnationId: '00000000-0000-4000-8000-000000000000',
        operationId: null,
      },
    }),
  ]
  const room = {
    members: ['builder', 'gone', 'ghost', 'reviewer'],
    leadAgentId: 'lead',
    kind: 'room' as const,
  }
  expect(stageMembers(room, roster).map((item) => item.id)).toEqual(['builder', 'reviewer', 'lead'])
  expect(
    stageMembers({ members: ['lead', 'builder'], leadAgentId: 'lead', kind: 'room' }, roster).map(
      (item) => item.id,
    ),
  ).toEqual(['lead', 'builder'])
  // A direct room has its one agent, even when the member list is empty.
  expect(
    stageMembers({ members: [], leadAgentId: 'designer', kind: 'direct' }, roster).map(
      (item) => item.id,
    ),
  ).toEqual(['designer'])
  expect(stageMembers({ members: [], leadAgentId: null, kind: 'room' }, roster)).toEqual([])
})

test('a new message from a member that mentions another member is a hand-off, once', () => {
  const ids = ['lead', 'builder', 'reviewer']
  const mention = message('m1', {
    author: { kind: 'agent', agentId: 'lead' },
    to: ['builder'],
    parts: [{ kind: 'text', text: 'take this one' }],
  })
  const seen = new Set<string>()
  expect(newHandoff([mention], seen, ids)).toEqual({ id: 'm1', from: 'lead', to: 'builder' })
  // Already seen, or what was there when the room opened: nothing.
  expect(newHandoff([mention], new Set(['m1']), ids)).toBeNull()
  // Mentioned in the text only; someone outside the room, yourself, and you as author are not hand-offs.
  const textual = message('m2', {
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'ready, @reviewer please look. cc @builder @ghost' }],
  })
  expect(newHandoff([textual], seen, ids)).toEqual({ id: 'm2', from: 'builder', to: 'reviewer' })
  const you = message('m3', { author: { kind: 'you' }, to: ['builder'] })
  const self = message('m4', { to: ['builder'] })
  const outside = message('m5', { to: ['ghost'] })
  expect(newHandoff([you, self, outside], seen, ids)).toBeNull()
})

test('an approval with no room attribution at all makes its agent wait in every room it is a member of', () => {
  const unscoped = approval({ refs: [{ kind: 'task', taskId: 't1' }], origin: 'gateway' })
  expect(stageMoods({ ...base, approvals: [unscoped] }).builder).toBe('needs')
  expect(stageMoods({ ...base, approvals: [approval({ refs: [] })] }).builder).toBe('needs')
  expect(stageMoods({ ...base, roomId: 'room-9', approvals: [unscoped] }).builder).toBe('needs')
  // Tied to another room: it stays out. Not actionable or decided: out as well.
  expect(
    stageMoods({ ...base, approvals: [approval({ refs: [{ kind: 'room', roomId: 'room-2' }] })] })
      .builder,
  ).toBe('rest')
  expect(
    stageMoods({ ...base, approvals: [approval({ refs: [], actionable: false })] }).builder,
  ).toBe('rest')
})

test('agent ids that are inherited object names are ordinary names', () => {
  const odd = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map((id) => ({
    id,
    status: 'idle' as const,
  }))
  const moods = stageMoods({ ...base, members: odd })
  for (const { id } of odd) expect(moods[id], id).toBe('rest')
  const busy = stageMoods({ ...base, members: odd, typing: { constructor: 'writing' } })
  expect(busy['constructor']).toBe('work')
  expect(busy['toString']).toBe('rest')
})

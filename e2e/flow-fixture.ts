import {
  BriefFlowSchema,
  FlowNodeDetailSchema,
  BriefLogPageSchema,
} from '../packages/contract/src/index.ts'
import { fixtureNow, nowFixture } from './now-fixture.ts'

export function flowFixture(roomId: string) {
  const score = nowFixture(roomId)
  const agents = score.lanes.map((lane) => lane.agent)
  const brief = {
    id: 'fixture-flow',
    title: 'Read layer and event stream',
    roomId,
    startedAt: '2026-10-08T20:30:00.000Z',
    startedBy: 'you',
    status: 'running',
  }
  const node = (
    id: string,
    title: string,
    agentId: string | null,
    state: string,
    col: number,
    row: number,
  ) => ({
    id,
    title,
    agentId,
    state,
    kind: id === 'brief:fixture-flow' ? 'brief' : 'step',
    subtitle: agentId ? `${agentId}, ${state}` : 'Started 20:30',
    taskId: id.startsWith('task:') ? id.slice(5) : null,
    layout: { col, row },
  })
  const nodes = [
    node('brief:fixture-flow', 'Brief from you', null, 'done', 0, 0),
    node('turn:plan', 'Plan the run', 'lead', 'done', 1, 0),
    node('task:read', 'Read layer', 'builder', 'done', 2, 0),
    node('task:stream', 'Event stream', 'builder', 'needs_you', 2, 1),
    node('task:states', 'Empty states', 'designer', 'planned', 2, 2),
    node('task:review', 'Re-review', 'reviewer', 'working', 3, 0),
    node('task:signoff', 'Sign-off', 'reviewer', 'planned', 3, 1),
    node('task:report', 'Report back', 'lead', 'planned', 3, 2),
  ]
  const edge = (from: string, to: string, kind = 'flow', label: string | null = null) => ({
    id: `${from}>${to}:${kind}`,
    from,
    to,
    kind,
    label,
  })
  const flow = BriefFlowSchema.parse({
    asOfSeq: 1,
    brief,
    nodes,
    edges: [
      edge(nodes[0]!.id, nodes[1]!.id),
      ...nodes.slice(2, 5).map((step) => edge(nodes[1]!.id, step.id)),
      edge('task:read', 'task:review', 'review', 'for review'),
      edge('task:review', 'task:read', 'sent_back', 'sent back'),
      edge('task:stream', 'task:signoff', 'planned'),
      edge('task:states', 'task:report', 'planned'),
    ],
    stats: { runningSec: 3660, steps: 41, handoffs: 6, spendUsd: 1.84, eta: null },
    notice: null,
  })
  const detail = FlowNodeDetailSchema.parse({
    node: nodes[3],
    description:
      'Push new task events to the browser, and pick up where it left off after a reconnect.',
    steps: [
      { id: 'subscribe', text: 'Subscribe to new task events', done: true },
      { id: 'send', text: 'Send events to the browser', done: false },
      { id: 'cursor', text: 'Reconnect from the last cursor', done: false },
      { id: 'tests', text: 'Tests for dropped connections', done: false },
    ],
    approval: score.focusApproval,
    run: {
      id: 'fixture-run',
      agentId: 'builder',
      origin: 'score',
      status: 'waiting_for_approval',
      startedAt: '2026-10-08T21:29:00.000Z',
      endedAt: null,
      model: 'Demo model',
      toolsUsed: ['terminal', 'files'],
      tokens: null,
      costUsd: null,
      refs: [],
      gaps: [],
    },
    model: 'Demo model',
    tools: ['terminal', 'files'],
    watch: null,
  })
  const log = BriefLogPageSchema.parse({
    items: [
      {
        id: 'edit',
        at: '2026-10-08T21:28:02.000Z',
        agentId: 'builder',
        kind: 'tool',
        text: 'Edited api/events.py, cursor is now (created_at, id)',
      },
      {
        id: 'test',
        at: '2026-10-08T21:28:40.000Z',
        agentId: 'builder',
        kind: 'tool',
        text: 'Ran cursor tests, all passing',
      },
      {
        id: 'handoff',
        at: '2026-10-08T21:29:05.000Z',
        agentId: 'builder',
        kind: 'handoff',
        text: 'Handed the read layer back to reviewer',
      },
      {
        id: 'review',
        at: '2026-10-08T21:29:11.000Z',
        agentId: 'reviewer',
        kind: 'message',
        text: 'Reading api/events.py',
      },
      {
        id: 'start',
        at: '2026-10-08T21:30:47.000Z',
        agentId: 'builder',
        kind: 'system',
        text: 'Started the event stream, planned 4 steps',
      },
      {
        id: 'approval',
        at: fixtureNow,
        agentId: 'builder',
        kind: 'approval',
        text: 'Asked you to approve npm install ws@8',
      },
    ],
    nextCursor: null,
  })
  return { score, agents, flow, detail, log }
}

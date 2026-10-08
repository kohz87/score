import { expect, test } from 'vitest'
import { buildLanes, type LaneInput, type LaneTaskInput } from '../../src/domain/lanes.ts'

const at = (hhmm: string) => `2026-10-08T${hhmm}:00.000Z`
const agentIds = ['lead', 'builder', 'reviewer', 'designer']
const task = (
  id: string,
  title: string,
  assignee: string | null,
  reviewer: string | null,
  column: LaneTaskInput['column'] = 'working',
): LaneTaskInput => ({ id, title, assignee, reviewer, column })
const run = (
  id: string,
  agentId: string,
  status: string,
  start: string,
  end: string | null,
  taskId: string | null,
) => ({ id, agentId, status, startedAt: at(start), endedAt: end ? at(end) : null, taskId })
const base = { agentIds, from: at('20:30'), to: at('22:00'), now: at('21:31') }

// The timeline drawn in docs/design/now-score.png, with neutral agents.
function designInput(): LaneInput {
  return {
    ...base,
    tasks: [
      task('plan', 'Plan and assign', 'lead', null, 'done'),
      task('read', 'Read layer for task events', 'builder', 'reviewer', 'in_review'),
      task('fix', 'Fix cursor', 'builder', 'reviewer', 'in_review'),
      task('stream', 'Stream', 'builder', 'reviewer', 'planned'),
      task('report', 'Report', 'lead', null, 'planned'),
      task('states', 'Empty and error states', 'designer', null, 'planned'),
    ],
    runs: [
      run('r1', 'lead', 'completed', '20:32', '20:46', 'plan'),
      run('r2', 'builder', 'completed', '20:47', '21:10', 'read'),
      run('r3', 'reviewer', 'completed', '21:11', '21:15', 'read'),
      run('r4', 'builder', 'completed', '21:16', '21:25', 'fix'),
      run('r5', 'reviewer', 'running', '21:26', null, 'fix'),
      run('r6', 'builder', 'waiting_for_approval', '21:31', null, 'stream'),
    ],
    hops: [
      { id: 'm1', runId: 'r2', fromAgentId: 'lead', agentId: 'builder', at: at('20:46') },
      { id: 'm2', runId: 'r4', fromAgentId: 'reviewer', agentId: 'builder', at: at('21:15') },
    ],
    waitingRunIds: [],
  }
}

test('design timeline produces the blocks and hand-offs of the Score view', () => {
  const out = buildLanes(designInput())
  const view = (agent: string) =>
    out.lanes.find((lane) => lane.agentId === agent)!.blocks.map((b) => [b.label, b.state])
  expect(view('lead')).toEqual([
    ['Plan and assign', 'done'],
    ['Report', 'planned'],
  ])
  expect(view('builder')).toEqual([
    ['Read layer for task events', 'done'],
    ['Fix cursor', 'done'],
    ['Waiting on you', 'waiting'],
    ['Stream', 'planned'],
  ])
  expect(view('reviewer')).toEqual([
    ['Review: Read layer for task events', 'done'],
    ['Review: Fix cursor', 'working'],
  ])
  expect(view('designer')).toEqual([['Empty and error states', 'planned']])
  expect(out.handoffs.map((h) => [h.from.agentId, h.to.agentId, h.kind])).toEqual([
    ['lead', 'builder', 'handoff'],
    ['builder', 'reviewer', 'review'],
    ['reviewer', 'builder', 'sent_back'],
    ['builder', 'reviewer', 'review'],
  ])
})

test('planned blocks start now and stay open-ended', () => {
  const planned = buildLanes(designInput()).lanes[0]!.blocks.at(-1)!
  expect(planned).toMatchObject({ id: 'task:report', start: at('21:31'), end: null, runId: null })
})

test('every agent gets a lane, even when empty', () => {
  const out = buildLanes({ ...base, tasks: [], runs: [], hops: [], waitingRunIds: [] })
  expect(out.lanes.map((lane) => lane.agentId)).toEqual(agentIds)
  expect(out.lanes.every((lane) => lane.blocks.length === 0)).toBe(true)
  expect(out.handoffs).toEqual([])
})

test('consecutive runs for one task merge; another agent in between splits them', () => {
  const tasks = [task('t', 'Ship it', 'builder', 'reviewer')]
  const merged = buildLanes({
    ...base,
    tasks,
    hops: [],
    waitingRunIds: [],
    runs: [
      run('a', 'builder', 'completed', '21:00', '21:05', 't'),
      run('b', 'builder', 'running', '21:06', null, 't'),
    ],
  })
  expect(merged.lanes[1]!.blocks).toEqual([
    {
      id: 'run:a',
      label: 'Ship it',
      state: 'working',
      start: at('21:00'),
      end: null,
      taskId: 't',
      runId: 'b',
    },
  ])
  const split = buildLanes({
    ...base,
    tasks,
    hops: [],
    waitingRunIds: [],
    runs: [
      run('a', 'builder', 'completed', '21:00', '21:05', 't'),
      run('r', 'reviewer', 'completed', '21:06', '21:08', 't'),
      run('b', 'builder', 'completed', '21:09', '21:10', 't'),
    ],
  })
  expect(split.lanes[1]!.blocks.map((b) => b.id)).toEqual(['run:a', 'run:b'])
  expect(split.handoffs.map((h) => h.kind)).toEqual(['review', 'sent_back'])
})

test('a pending approval turns its run into a waiting block', () => {
  const out = buildLanes({
    ...base,
    tasks: [],
    hops: [],
    runs: [run('a', 'builder', 'running', '21:00', null, null)],
    waitingRunIds: ['a'],
  })
  expect(out.lanes[1]!.blocks[0]).toMatchObject({ state: 'waiting', end: null })
})

test('blocks are clipped to the window and out-of-window ones dropped', () => {
  const out = buildLanes({
    ...base,
    tasks: [],
    hops: [],
    waitingRunIds: [],
    runs: [
      run('early', 'builder', 'completed', '19:00', '20:00', null),
      run('edge', 'builder', 'completed', '20:00', '20:45', null),
      run('late', 'builder', 'completed', '21:50', '22:30', null),
      run('after', 'builder', 'completed', '22:10', '22:20', null),
    ],
  })
  expect(out.lanes[1]!.blocks.map((b) => [b.id, b.start, b.end])).toEqual([
    ['run:edge', at('20:30'), at('20:45')],
    ['run:late', at('21:50'), at('22:00')],
  ])
})

test('hand-offs need both blocks inside the window', () => {
  const input = designInput()
  const out = buildLanes({ ...input, from: at('21:12') })
  expect(out.handoffs.every((h) => h.at >= at('21:12'))).toBe(true)
  expect(out.handoffs.map((h) => h.kind)).toEqual(['sent_back', 'review'])
})

test('unknown agents get no lane and a task in review without a reviewer run plans one', () => {
  const out = buildLanes({
    ...base,
    hops: [],
    waitingRunIds: [],
    tasks: [task('t', 'Check docs', 'builder', 'reviewer', 'in_review')],
    runs: [run('x', 'ghost', 'running', '21:00', null, null)],
  })
  expect(out.lanes.map((lane) => lane.agentId)).toEqual(agentIds)
  expect(out.lanes[2]!.blocks.map((b) => [b.id, b.state])).toEqual([['task:t:review', 'planned']])
})

test("a hand-off connects the exact source run, not the source agent's latest block", () => {
  const out = buildLanes({
    ...designInput(),
    tasks: [],
    runs: [
      run('a', 'lead', 'completed', '20:31', '20:35', null),
      run('b', 'lead', 'completed', '20:40', '20:45', null),
      run('c', 'builder', 'completed', '20:50', '20:55', null),
    ],
    hops: [
      {
        id: 'm',
        runId: 'c',
        fromAgentId: 'lead',
        parentRunId: 'a',
        agentId: 'builder',
        at: at('20:35'),
      },
    ],
  })
  expect(out.handoffs.map((h) => h.from.blockId)).toEqual([expect.stringContaining('a')])
  expect(out.handoffs).toHaveLength(1)
})

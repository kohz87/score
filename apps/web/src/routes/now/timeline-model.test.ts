import { expect, test } from 'vitest'
import type { LaneBlock } from '@score/contract'
import {
  axisTicks,
  connectors,
  laneItems,
  layoutBlock,
  MIN_BLOCK_PX,
  percent,
  windowOf,
} from './timeline-model.ts'

const now = '2026-10-08T12:00:00.000Z'
const window = windowOf(now)
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString()

test('the window runs an hour back and half an hour ahead (as in the design), so the now line sits at two thirds', () => {
  expect(percent(window, window.now)).toBeCloseTo(66.67, 1)
  expect(percent(window, window.from - 1000)).toBe(0)
  expect(percent(window, window.to + 1000)).toBe(100)
})

test('blocks: done and working use their times, planned gets a default length, waiting sits at the now line', () => {
  const base = { id: 'b', label: 'x', taskId: null, runId: null, kind: 'task' as const }
  const done = layoutBlock(window, { ...base, state: 'done', start: at(-50), end: at(-35) })
  expect(done.width).toBeCloseTo(100 / 6, 1)
  const working = layoutBlock(window, { ...base, state: 'working', start: at(-30), end: null })
  expect(working.left + (working.width ?? 0)).toBeCloseTo(66.67, 1)
  const planned = layoutBlock(window, { ...base, state: 'planned', start: at(10), end: null })
  expect(planned.width).toBeGreaterThan(0)
  const waiting = layoutBlock(window, { ...base, state: 'waiting', start: at(-20), end: null })
  expect(waiting).toMatchObject({ atNow: true, width: null })
  expect(waiting.left).toBeCloseTo(66.67, 1)
})

test('axis ticks are quarter hours inside the window and skip the one under the now label', () => {
  const ticks = axisTicks(window)
  expect(ticks.length).toBeGreaterThanOrEqual(5)
  expect(ticks.every((tick) => /^\d\d:(00|15|30|45)$/.test(tick.label))).toBe(true)
  expect(ticks.some((tick) => Math.abs(tick.left - 66.67) <= 4)).toBe(false)
})

test('connectors join the end of one block to the start of the next and skip unknown blocks', () => {
  const agent = (id: string) =>
    ({ id, name: id, role: '', style: { color: '#000000', shape: 'circle-dot' } }) as never
  const block = (id: string, start: number, end: number) => ({
    id,
    label: id,
    state: 'done' as const,
    start: at(start),
    end: at(end),
    taskId: null,
    runId: null,
    kind: 'task' as const,
  })
  const result = connectors(
    {
      lanes: [
        { agent: agent('lead'), blocks: [block('a', -90, -60)] },
        { agent: agent('builder'), blocks: [block('b', -60, -30)] },
      ],
      handoffs: [
        {
          id: 'h1',
          from: { agentId: 'lead', blockId: 'a' },
          to: { agentId: 'builder', blockId: 'b' },
          kind: 'handoff',
          at: at(-60),
        },
        {
          id: 'h2',
          from: { agentId: 'lead', blockId: 'a' },
          to: { agentId: 'builder', blockId: 'missing' },
          kind: 'review',
          at: at(-60),
        },
      ],
    },
    window,
  )
  expect(result.map((item) => item.id)).toEqual(['h1'])
  expect(result[0]!.d.startsWith('M')).toBe(true)
  expect(result[0]).toMatchObject({ fromAgentId: 'lead', toAgentId: 'builder' })
})

const mk = (
  id: string,
  from: number,
  to: number | null,
  extra: Partial<LaneBlock> = {},
): LaneBlock => ({
  id,
  label: id,
  state: to === null ? 'working' : 'done',
  start: at(from),
  end: to === null ? null : at(to),
  taskId: id,
  runId: null,
  kind: 'task',
  ...extra,
})

test('lane items: blocks that fit stay blocks, back-to-back runs are not an overlap', () => {
  const items = laneItems(window, [mk('a', -50, -35), mk('b', -35, -20), mk('c', -10, 0)], 1000)
  expect(items.map((item) => item.kind)).toEqual(['block', 'block', 'block'])
})

test('lane items: overlapping blocks form one counted group', () => {
  const items = laneItems(window, [mk('a', -50, -20), mk('b', -40, -10), mk('c', -5, 0)], 1000)
  expect(items.map((item) => item.kind)).toEqual(['group', 'block'])
  const group = items[0]!
  expect(group.kind === 'group' && group.blocks.map((block) => block.id)).toEqual(['a', 'b'])
  expect(group.layout.block.label).toBe('2 tasks')
  expect(group.layout.left).toBeCloseTo(percent(window, Date.parse(at(-50))), 5)
})

test('lane items: blocks narrower than the minimum cluster with near neighbours; a lone one stays', () => {
  // 1 minute of a 90 minute window on a 1000 px plot is about 11 px: under the 28 px minimum.
  const near = laneItems(window, [mk('a', -30, -29), mk('b', -28, -27)], 1000)
  expect(near).toHaveLength(1)
  expect(near[0]!.kind).toBe('group')
  const far = laneItems(window, [mk('a', -60, -59), mk('b', -10, -9)], 1000)
  expect(far.map((item) => item.kind)).toEqual(['block', 'block'])
  expect(MIN_BLOCK_PX).toBe(28)
  // On a narrow plot the same short blocks cannot be told apart.
  expect(laneItems(window, [mk('a', -50, -45), mk('b', -43, -38)], 300)[0]!.kind).toBe('group')
})

test('lane items: chat is a band, waiting blocks are never grouped, group state is the most urgent', () => {
  const items = laneItems(
    window,
    [
      mk('chat', -50, -20, { kind: 'chat', count: 3, taskId: null }),
      mk('a', -50, -20),
      mk('b', -45, null),
      mk('w', -30, null, { state: 'waiting' }),
    ],
    1000,
  )
  expect(items.map((item) => item.kind).sort()).toEqual(['block', 'chat', 'group'])
  const group = items.find((item) => item.kind === 'group')!
  expect(group.layout.block.state).toBe('working')
  expect(items.find((item) => item.kind === 'block')!.layout.block.id).toBe('w')
})

test('connectors attach to a group and to the chat band', () => {
  const agent = (id: string) =>
    ({ id, name: id, role: '', style: { color: '#000000', shape: 'circle-dot' } }) as never
  const result = connectors(
    {
      lanes: [
        { agent: agent('lead'), blocks: [mk('a', -50, -20), mk('b', -45, -15)] },
        { agent: agent('builder'), blocks: [mk('c', -10, -5, { kind: 'chat', taskId: null })] },
      ],
      handoffs: [
        {
          id: 'h',
          from: { agentId: 'lead', blockId: 'b' },
          to: { agentId: 'builder', blockId: 'c' },
          kind: 'handoff',
          at: at(-10),
        },
      ],
    },
    window,
  )
  expect(result).toHaveLength(1)
  expect(result[0]!.fromLabel).toBe('b')
})

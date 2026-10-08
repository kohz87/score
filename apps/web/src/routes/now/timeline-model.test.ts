import { expect, test } from 'vitest'
import { axisTicks, connectors, layoutBlock, percent, windowOf } from './timeline-model.ts'

const now = '2026-10-08T12:00:00.000Z'
const window = windowOf(now)
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString()

test('the window runs an hour back and half an hour ahead (as in the design), so the now line sits at two thirds', () => {
  expect(percent(window, window.now)).toBeCloseTo(66.67, 1)
  expect(percent(window, window.from - 1000)).toBe(0)
  expect(percent(window, window.to + 1000)).toBe(100)
})

test('blocks: done and working use their times, planned gets a default length, waiting sits at the now line', () => {
  const base = { id: 'b', label: 'x', taskId: null, runId: null }
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

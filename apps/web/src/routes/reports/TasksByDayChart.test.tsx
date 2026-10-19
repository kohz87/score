import { ShapeSchema, type AgentSummary, type Shape } from '@score/contract'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { stubReducedMotion } from '../../motion/test-support.ts'
import { patternByShape, TasksByDayChart } from './TasksByDayChart.tsx'

beforeEach(() => stubReducedMotion())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function agent(id: string, color: string, shape: Shape): AgentSummary {
  return {
    id,
    name: id,
    role: id,
    style: { color, shape },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  }
}

const agents = [
  agent('lead', '#6B4EFF', 'circle-dot'),
  agent('builder', '#19C39A', 'triangle'),
  agent('reviewer', '#FFB61E', 'diamond'),
]

const week: { date: string; perAgent: Record<string, number> }[] = [
  { date: '2026-10-05', perAgent: { lead: 1, builder: 2, reviewer: 1 } },
  { date: '2026-10-06', perAgent: { lead: 1, builder: 3, reviewer: 1, designer: 1 } },
  { date: '2026-10-07', perAgent: { lead: 0, builder: 0, reviewer: 0 } },
]

function fills(container: HTMLElement, day: string) {
  return [...container.querySelectorAll(`g[data-day="${day}"] g[data-agent]`)].map((g) => ({
    agent: g.getAttribute('data-agent'),
    height: Number(g.querySelector('[data-part="fill"]')!.getAttribute('height')),
    y: Number(g.querySelector('[data-part="fill"]')!.getAttribute('y')),
    fill: g.querySelector('[data-part="fill"]')!.getAttribute('fill'),
    pattern: g.querySelector('[data-part="pattern"]')!.getAttribute('data-pattern'),
  }))
}

test('segments stack in agent order, bottom to top, with proportional heights', () => {
  const { container } = render(<TasksByDayChart byDay={week} agents={agents} />)
  const day = fills(container, '2026-10-05')
  expect(day.map((s) => s.agent)).toEqual(['lead', 'builder', 'reviewer'])
  // maxTotal is 6, so 1 task = 208/6; each segment loses the 3px gap.
  const unit = 208 / 6
  expect(day.map((s) => s.height)).toEqual([unit - 3, 2 * unit - 3, unit - 3])
  expect(day[0]!.y).toBeGreaterThan(day[1]!.y)
  expect(day[1]!.y).toBeGreaterThan(day[2]!.y)
  expect(day[0]!.fill).toBe('#6B4EFF')
})

test('each agent shape gets its own pattern and colour', () => {
  const { container } = render(<TasksByDayChart byDay={week} agents={agents} />)
  const day = fills(container, '2026-10-05')
  expect(new Set(day.map((s) => s.pattern)).size).toBe(3)
  expect(new Set(day.map((s) => s.fill)).size).toBe(3)
})

test('hidden table matches the data and totals', () => {
  render(<TasksByDayChart byDay={week} agents={agents} />)
  const rows = within(screen.getByRole('table')).getAllByRole('row')
  const cells = rows.map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent))
  expect(cells[0]).toEqual(['Day', 'lead', 'builder', 'reviewer', 'designer', 'Total'])
  expect(cells[1]).toEqual(['2026-10-05', '1', '2', '1', '0', '4'])
  expect(cells[2]).toEqual(['2026-10-06', '1', '3', '1', '1', '6'])
  expect(cells[3]).toEqual(['2026-10-07', '0', '0', '0', '0', '0'])
})

test('has a summary label and a legend entry per agent', () => {
  render(<TasksByDayChart byDay={week} agents={agents} />)
  expect(screen.getByRole('img', { name: /10 in total over 3 days/ })).toBeTruthy()
  const legend = screen.getByRole('list', { name: 'Agents' })
  expect(within(legend).getAllByRole('listitem')).toHaveLength(4)
  expect(
    screen
      .getByRole('region', { name: 'Tasks by day chart, scroll to see all days' })
      .getAttribute('tabindex'),
  ).toBe('0')
})

test('unknown agents render in neutral grey with their id', () => {
  const { container } = render(<TasksByDayChart byDay={week} agents={agents} />)
  const day = fills(container, '2026-10-06')
  expect(day.at(-1)).toMatchObject({ agent: 'designer', fill: 'var(--agent-unknown)' })
})

test('all-zero days draw no segments and a single day works', () => {
  const { container } = render(
    <TasksByDayChart byDay={[{ date: '2026-10-07', perAgent: {} }]} agents={agents} />,
  )
  expect(container.querySelectorAll('g[data-agent]')).toHaveLength(0)
  expect(screen.getByText('Wed')).toBeTruthy()
})

test('empty data renders without bars', () => {
  const { container } = render(<TasksByDayChart byDay={[]} agents={agents} />)
  expect(container.querySelectorAll('g[data-day]')).toHaveLength(0)
})

test('30 days render all bars with sparse axis labels', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    perAgent: { lead: i % 4, builder: 1 },
  }))
  const { container } = render(<TasksByDayChart byDay={days} agents={agents} />)
  expect(container.querySelectorAll('g[data-day]')).toHaveLength(30)
  const labels = [...container.querySelectorAll('.tasks-by-day__label')].filter(
    (t) => t.textContent,
  )
  expect(labels.length).toBeLessThan(10)
})

test.each([1, 2, 45, 366])(
  'draws %i days without overflowing and keeps every day in the table',
  (count) => {
    const start = Date.UTC(2025, 0, 1)
    const byDay = Array.from({ length: count }, (_, i) => ({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      perAgent: { lead: i % 3, builder: 1 },
    }))
    const { container } = render(<TasksByDayChart byDay={byDay} agents={agents} />)
    expect(container.querySelectorAll('g[data-day]')).toHaveLength(count)
    for (const rect of container.querySelectorAll('g[data-day] rect')) {
      expect(Number(rect.getAttribute('width'))).toBeGreaterThan(0)
    }
    expect(container.querySelectorAll('.tasks-by-day__sr-only tbody tr')).toHaveLength(count)
    // Past a month the per-bar totals and most axis labels would collide.
    expect(container.querySelectorAll('.tasks-by-day__total').length).toBe(count <= 31 ? count : 0)
    const labels = [...container.querySelectorAll('.tasks-by-day__label')].filter(
      (t) => t.textContent,
    )
    expect(labels.length).toBeLessThanOrEqual(count <= 7 ? count : 8)
  },
)

test('all twenty shapes have their own pattern overlay and every pattern draws something', () => {
  const kinds = Object.values(patternByShape)
  expect(kinds).toHaveLength(ShapeSchema.options.length)
  expect(new Set(kinds).size).toBe(ShapeSchema.options.length)
  const day = [
    {
      date: '2026-10-19',
      perAgent: Object.fromEntries(ShapeSchema.options.map((shape) => [`a-${shape}`, 1])),
    },
  ]
  const everyone = ShapeSchema.options.map((shape) => agent(`a-${shape}`, '#6B4EFF', shape))
  const { container } = render(<TasksByDayChart byDay={day} agents={everyone} />)
  const patterns = [...container.querySelectorAll('pattern')]
  expect(patterns).toHaveLength(20)
  for (const pattern of patterns) expect(pattern.children.length, pattern.id).toBeGreaterThan(0)
})

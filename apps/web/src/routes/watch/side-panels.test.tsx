import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AgentSummary, WatchOverviewItem } from '@score/contract'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { OtherScreens, WhatTheyAreDoing } from './SidePanels.tsx'
import type { ActivityItem } from './watch-model.ts'

afterEach(cleanup)

const items: ActivityItem[] = Array.from({ length: 7 }, (_, index) => ({
  key: `frame-${7 - index}`,
  kind: index === 1 ? 'asked' : index % 2 ? 'file' : 'command',
  text: `Step ${7 - index}`,
  at: new Date(Date.UTC(2026, 9, 8, 21, 30, 60 - index * 5)).toISOString(),
  seq: 7 - index,
}))

test('what they are doing lists the newest five first, highlights the current one and expands', () => {
  const onSelect = vi.fn()
  render(
    <WhatTheyAreDoing
      agent={{ name: 'builder' }}
      items={items}
      currentKey="frame-7"
      live
      onSelect={onSelect}
    />,
  )
  expect(screen.getByRole('heading', { name: 'What builder is doing' })).toBeTruthy()
  const list = screen.getByRole('list')
  expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain('Step 7')
  const current = screen.getByRole('button', { name: /Step 7/ })
  expect(current.getAttribute('aria-current')).toBe('true')
  expect(current.textContent).toMatch(/\d\d:\d\d:\d\d, now/)
  expect(screen.getByRole('button', { name: /Step 6/ }).textContent).not.toContain('now')
  // Colour is never the only cue: each dot has a name.
  expect(within(current).getByRole('img', { name: 'Command' })).toBeTruthy()
  expect(
    within(screen.getByRole('button', { name: /Step 6/ })).getByRole('img', { name: 'Asked you' }),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Step 5/ }))
  expect(onSelect).toHaveBeenCalledWith(items[2])
  const more = screen.getByRole('button', { name: 'Full history' })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(more)
  expect(within(list).getAllByRole('listitem')).toHaveLength(7)
  expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
    'true',
  )
})

test('while replaying, the replayed step is the highlighted one and nothing says now', () => {
  render(
    <WhatTheyAreDoing
      agent={{ name: 'builder' }}
      items={items}
      currentKey="frame-4"
      live={false}
      onSelect={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: /Step 4/ }).getAttribute('aria-current')).toBe('true')
  expect(screen.queryByText(/, now/)).toBeNull()
})

test('a sub-agent’s steps sit in one group under a Sub-agent label', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 8, 21, 30, n)).toISOString()
  const list: ActivityItem[] = [
    { key: 'frame-4', kind: 'command', text: 'Ran the tests', at: at(4), seq: 4 },
    { key: 'frame-3', kind: 'file', text: 'Edited a.ts', at: at(3), seq: 3, sub: true },
    { key: 'frame-2', kind: 'command', text: 'Ran ls', at: at(2), seq: 2, sub: true },
    { key: 'frame-1', kind: 'command', text: 'Ran git status', at: at(1), seq: 1 },
  ]
  render(
    <WhatTheyAreDoing
      agent={{ name: 'builder' }}
      items={list}
      currentKey="frame-4"
      live
      onSelect={vi.fn()}
    />,
  )
  expect(screen.getByText('Sub-agent · 2 steps')).toBeTruthy()
  const nested = screen.getByRole('list', { name: 'Sub-agent steps' })
  expect(within(nested).getAllByRole('listitem')).toHaveLength(2)
  expect(within(nested).getByRole('button', { name: /Edited a\.ts/ })).toBeTruthy()
  expect(screen.queryByText(/Sub-agent · Edited/)).toBeNull()
  // The group is one entry in the list of five, so nothing here is hidden.
  expect(screen.queryByRole('button', { name: 'Full history' })).toBeNull()
})

test('C1: two back-to-back sub-agents show as two groups', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 8, 21, 30, n)).toISOString()
  const step = (seq: number, parentCallId: string): ActivityItem => ({
    key: `frame-${seq}`,
    kind: 'command',
    text: `Ran step ${seq}`,
    at: at(seq),
    seq,
    sub: true,
    parentCallId,
  })
  render(
    <WhatTheyAreDoing
      agent={{ name: 'builder' }}
      items={[step(3, 'agent-b'), step(2, 'agent-a'), step(1, 'agent-a')]}
      currentKey="frame-3"
      live
      onSelect={vi.fn()}
    />,
  )
  expect(screen.getByText('Sub-agent · 1 step')).toBeTruthy()
  expect(screen.getByText('Sub-agent · 2 steps')).toBeTruthy()
  expect(screen.getAllByRole('list', { name: 'Sub-agent steps' })).toHaveLength(2)
})

const agent = (id: string, color: string, shape: AgentSummary['style']['shape']): AgentSummary => ({
  id,
  name: id,
  role: '',
  style: { color, shape },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const overview: WatchOverviewItem[] = [
  {
    agent: agent('builder', '#19C39A', 'triangle'),
    thumbnail: null,
    status: 'Working',
    live: true,
    surface: 'terminal',
  },
  {
    agent: agent('reviewer', '#FFB61E', 'diamond'),
    thumbnail: null,
    status: 'reviewing',
    live: true,
    surface: 'editor',
  },
  {
    agent: agent('designer', '#FF6B8A', 'square'),
    thumbnail: null,
    status: 'idle',
    live: false,
    surface: null,
  },
  {
    agent: agent('lead', '#6B4EFF', 'circle-dot'),
    thumbnail: '/api/media/t1',
    status: 'planning',
    live: true,
    surface: 'browser',
  },
]

test('other screens skip this agent and link each of the others to its own watch page', () => {
  render(
    <MemoryRouter>
      <OtherScreens items={overview} currentAgentId="builder" failed={false} />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('link', { name: /builder/ })).toBeNull()
  const reviewer = screen.getByRole('link', { name: /reviewer/ })
  expect(reviewer.getAttribute('href')).toBe('/watch/reviewer')
  expect(reviewer.textContent).toContain('reviewing')
  const designer = screen.getByRole('link', { name: /designer/ })
  expect(designer.textContent).toContain('No desktop open')
  expect(designer.textContent).toContain('idle')
  expect(
    within(screen.getByRole('link', { name: /lead/ }))
      .getByRole('img', { name: 'lead’s screen' })
      .getAttribute('src'),
  ).toBe('/api/media/t1')
})

test('other screens say when they are loading, failed or alone', () => {
  const { rerender } = render(
    <MemoryRouter>
      <OtherScreens items={undefined} currentAgentId="builder" failed={false} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('status').textContent).toContain('Loading')
  rerender(
    <MemoryRouter>
      <OtherScreens items={undefined} currentAgentId="builder" failed />
    </MemoryRouter>,
  )
  expect(screen.getByRole('alert').textContent).toContain('Couldn’t load')
  rerender(
    <MemoryRouter>
      <OtherScreens items={[overview[0]!]} currentAgentId="builder" failed={false} />
    </MemoryRouter>,
  )
  expect(screen.getByText('No other agents are on the team yet.')).toBeTruthy()
})

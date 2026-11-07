import { fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import {
  at,
  boldTasksState as state,
  column,
  detailOf,
  mount,
  room,
  task,
} from './BoldTasks-helpers.tsx'

test('five columns with counts, cards with key, room, badge, progress and agent', async () => {
  state.tasks = [
    task('t1', { progress: 0.6 }),
    task('t2', {
      column: 'planned',
      elapsedSec: null,
      badge: { kind: 'starts_after', label: 'Starts after T-1' },
    }),
    task('t3', { column: 'in_review' }),
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
    task('t5', { column: 'done', roomId: null }),
  ]
  state.details.t1 = detailOf(state.tasks[0]!)
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  for (const [name, count] of [
    ['Planned', '1'],
    ['Working', '1'],
    ['In review', '1'],
    ['Needs you', '1'],
    ['Done', '1'],
  ] as const)
    expect(within(column(name)).getByRole('heading').textContent).toContain(count)
  const card = screen.getByRole('button', { name: 'T1 Task t1' })
  expect(card.textContent).toContain('Feed team')
  expect(card.textContent).toContain('14 min')
  expect(within(card).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60')
  expect(screen.getByRole('button', { name: 'T2 Task t2' }).textContent).toContain(
    'Starts after T-1',
  )
  expect(screen.getByRole('button', { name: 'T5 Task t5' }).textContent).toContain('No room')
  const needs = screen.getByRole('button', { name: 'T4 Task t4' })
  expect(needs.hasAttribute('data-protected')).toBe(true)
  expect(screen.getByText('1 need you').hasAttribute('data-protected')).toBe(true)
})

test('filters by agent, and shows the room filter only across two rooms', async () => {
  state.tasks = [task('t1'), task('t2', { assignee: 'lead' })]
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  expect(screen.queryByRole('group', { name: 'Filter by room' })).toBeNull()
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Filter by agent' })).getByRole('button', {
      name: 'lead',
    }),
  )
  expect(screen.queryByRole('button', { name: 'T1 Task t1' })).toBeNull()
  expect(screen.getByRole('button', { name: 'T2 Task t2' })).toBeTruthy()
  expect(within(column('Planned')).getByText('Nothing here for this filter.')).toBeTruthy()
})

test('filters by room when tasks span two rooms', async () => {
  state.rooms = [room('room-a', 'Feed team'), room('room-b', 'Billing team')]
  state.tasks = [task('t1'), task('t2', { roomId: 'room-b' })]
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  const filter = screen.getByRole('group', { name: 'Filter by room' })
  fireEvent.click(within(filter).getByRole('button', { name: 'Billing team' }))
  expect(screen.queryByRole('button', { name: 'T1 Task t1' })).toBeNull()
  expect(screen.getByRole('button', { name: 'T2 Task t2' })).toBeTruthy()
})

test('Done lists the 20 newest and "Show older" the rest', async () => {
  state.tasks = Array.from({ length: 23 }, (_, index) =>
    task(`d${String(index).padStart(2, '0')}`, { column: 'done', updatedAt: at(index + 1) }),
  )
  mount()
  await screen.findByRole('button', { name: 'D00 Task d00' })
  expect(within(column('Done')).getAllByRole('button', { name: /^D\d\d/ })).toHaveLength(20)
  fireEvent.click(screen.getByRole('button', { name: 'Show older (3)' }))
  expect(within(column('Done')).getAllByRole('button', { name: /^D\d\d/ })).toHaveLength(23)
})

test('empty states: no tasks at all, and a filter with nothing', async () => {
  mount()
  expect(
    await screen.findByText(/No tasks yet\. Hermes tasks your agents create show up here\./),
  ).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Filter by agent' })).toBeNull()
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { Job } from '@score/contract'
import type { JobRead } from './room-queries.ts'
import { makeJob } from './room-test-utils.tsx'
import { RoomTabs } from './RoomTabs.tsx'
import type { JobFilter } from './room-model.ts'

afterEach(cleanup)

const jobs: JobRead[] = [
  makeJob({
    id: 'default',
    title: 'Team room',
    isDefault: true,
    state: 'working',
    unread: 9,
  }),
  makeJob({ id: 'feed', title: 'Activity feed', state: 'waiting_on_you', unread: 2 }),
  makeJob({ id: 'notes', title: 'Release notes', state: 'working', unread: 3 }),
  makeJob({ id: 'queue', title: 'Queue research', state: 'done', unread: 0 }),
  makeJob({ id: 'old', title: 'Closed job', state: 'closed', unread: 4 }),
]

function show(selectedJob = 'all', filter: JobFilter = 'all') {
  const onSelectJob = vi.fn()
  const onSelectFilter = vi.fn()
  render(
    <RoomTabs
      jobs={jobs}
      selectedJob={selectedJob}
      filter={filter}
      onSelectJob={onSelectJob}
      onSelectFilter={onSelectFilter}
    />,
  )
  return { onSelectJob, onSelectFilter }
}

test('All counts the named jobs’ unread messages, not the default job’s room thread', () => {
  show()
  const all = screen.getByRole('tab', { name: /^All/ })
  expect(all.getAttribute('aria-selected')).toBe('true')
  expect(all.querySelector('[aria-label="5 unread"]')?.textContent).toBe('5')
  // 2 + 3; the default job's 9 and the closed job's 4 are not in All.
  expect(all.textContent).not.toContain('18')
  expect(screen.getByRole('tab', { name: /Activity feed/ }).textContent).toContain('2')
  expect(screen.getByRole('tab', { name: /Release notes/ }).textContent).toContain('3')
  expect(screen.queryByRole('tab', { name: /Closed job/ })).toBeNull()
  expect(screen.getByRole('tab', { name: /Queue research/ }).textContent).not.toContain('0')
  expect(screen.queryByRole('tab', { name: /Team room/ })).toBeNull()
})

test('selecting a job and a filter calls the room with the job id and D10 filter', () => {
  const { onSelectJob, onSelectFilter } = show()
  fireEvent.click(screen.getByRole('tab', { name: /Release notes/ }))
  expect(onSelectJob).toHaveBeenCalledWith('notes')
  for (const [label, value] of [
    ['Needs you', 'needs'],
    ['Working', 'working'],
    ['Done', 'done'],
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`) }))
    expect(onSelectFilter).toHaveBeenCalledWith(value)
  }
})

test('a filter shows only the jobs in that state and marks itself pressed', () => {
  show('all', 'needs')
  expect(screen.getByRole('tab', { name: /Activity feed/ })).toBeDefined()
  expect(screen.queryByRole('tab', { name: /Release notes/ })).toBeNull()
  expect(screen.queryByRole('tab', { name: /Queue research/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Needs you' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  expect(screen.getByRole('button', { name: 'Working' }).getAttribute('aria-pressed')).toBe('false')
})

test('Closed jobs is its own list, and only there does a closed job appear', () => {
  show('all', 'closed')
  expect(screen.getByRole('tab', { name: /Closed job/ }).textContent).toContain('4')
  expect(screen.queryByRole('tab', { name: /Activity feed/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Closed jobs' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
})

test('the selected tab carries the on state and its title names the state', () => {
  show('queue')
  const selected = screen.getByRole('tab', { name: /Queue research/ })
  expect(selected.getAttribute('aria-selected')).toBe('true')
  expect(selected.getAttribute('title')).toBe('Queue research · Done')
  expect(selected.querySelector('.bold-job-dot')).toBeTruthy()
})

test('no unread counts render when every named job is read', () => {
  const read = jobs.map((job): Job => ({ ...job, unread: 0 }))
  render(
    <RoomTabs
      jobs={read}
      selectedJob="all"
      filter="all"
      onSelectJob={vi.fn()}
      onSelectFilter={vi.fn()}
    />,
  )
  expect(screen.queryAllByLabelText(/unread/)).toHaveLength(0)
})

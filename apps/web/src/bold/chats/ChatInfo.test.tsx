import { screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, makeJob, renderInRoom, room } from '../room/room-test-utils.tsx'
import { ChatInfo } from './ChatInfo.tsx'
import { openAllInfoSections, resetInfoFolds } from './info-test-utils.ts'

// The sections start folded or open by kind (3.27.1); these tests read inside all of them.
beforeEach(openAllInfoSections)

afterEach(() => {
  resetInfoFolds()
  disposeRoomTest()
  vi.unstubAllGlobals()
})

// 3.28.0 (decision 164): one job per chat. Info shows This job and Past jobs; the New topic form is gone.
const defaultJob = makeJob({
  id: 'job-default',
  title: 'Team room',
  isDefault: true,
  state: 'open',
})

test('Info shows This job for the one active job and Past jobs for the finished ones, newest first, with no New topic form', () => {
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[
        defaultJob,
        makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
        makeJob({
          id: 'job-old',
          title: 'Old import',
          state: 'closed',
          createdAt: '2026-10-20T09:00:00.000Z',
        }),
        makeJob({
          id: 'job-done',
          title: 'Release notes',
          state: 'done',
          createdAt: '2026-10-22T09:00:00.000Z',
        }),
      ]}
      everyone
    />,
  )
  expect(screen.getByRole('heading', { name: 'This job' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: /This topic/ })).toBeNull()
  expect(screen.queryByRole('heading', { name: /Open jobs/ })).toBeNull()
  const past = screen.getByRole('heading', { name: /Past jobs/ })
  expect(past).toBeDefined()
  const rows = [...(past.closest('section')?.querySelectorAll('li a') ?? [])].map(
    (link) => link.textContent,
  )
  expect(rows).toEqual([
    expect.stringContaining('Release notes'),
    expect.stringContaining('Old import'),
  ])
  // The running job is This job, not a row of Past jobs.
  expect(past.closest('section')?.textContent).not.toContain('Activity feed')
  expect(screen.queryByLabelText('Topic title')).toBeNull()
  expect(screen.queryByRole('button', { name: 'New topic' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Topics' })).toBeNull()
})

test('a past job row opens that job’s conversation', () => {
  renderInRoom(
    <>
      <ChatInfo
        room={room}
        agents={agents}
        jobs={[defaultJob, makeJob({ id: 'job-old', title: 'Old import', state: 'closed' })]}
        everyone
      />
    </>,
  )
  expect(screen.getByRole('link', { name: /Old import/ }).getAttribute('href')).toBe(
    '/b?job=job-old',
  )
})

test('an older chat that still holds several active jobs lists them under Open jobs with their needs-you mark', () => {
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[
        defaultJob,
        makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
        makeJob({ id: 'job-2', title: 'Release notes', state: 'waiting_on_you' }),
        makeJob({ id: 'job-old', title: 'Old import', state: 'closed' }),
      ]}
      everyone
    />,
  )
  const open = screen.getByRole('heading', { name: /Open jobs/ }).closest('section')!
  expect(open.querySelectorAll('li').length).toBe(2)
  expect(open.querySelector('.bold-info-needs')?.getAttribute('data-protected')).toBe('inline-flex')
  const past = screen.getByRole('heading', { name: /Past jobs/ }).closest('section')!
  expect(past.textContent).toContain('Old import')
  expect(past.textContent).not.toContain('Activity feed')
})

test('on a phone, Info keeps Start a job beside the sections', () => {
  const onNavigate = vi.fn()
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[defaultJob]}
      everyone
      phone
      onNavigate={onNavigate}
    />,
  )
  expect(screen.getByRole('button', { name: 'Start a job' })).toBeDefined()
})

test('each topic row shows its unread count; closed topics stay listed with a check', () => {
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[
        makeJob({ id: 'job-1', title: 'Activity feed', unread: 3 }),
        makeJob({ id: 'job-2', title: 'Quiet one', unread: 0 }),
        makeJob({ id: 'job-3', title: 'Old news', state: 'closed', unread: 120 }),
      ]}
      everyone
    />,
  )
  const feed = screen.getByRole('link', { name: /Activity feed/ })
  expect(feed.querySelector('.bold-unread')?.textContent).toBe('3')
  expect(screen.getByLabelText('3 unread')).toBeDefined()
  expect(screen.getByRole('link', { name: /Quiet one/ }).querySelector('.bold-unread')).toBeNull()
  const closed = screen.getByRole('link', { name: /Old news/ })
  expect(closed.textContent).toContain('✓')
  expect(closed.querySelector('.bold-unread')?.textContent).toBe('99+')
  expect(document.querySelector('details.bold-chat-closed')).toBeNull()
})

test('every finished job is a Past jobs row (there is no Closed topics disclosure any more)', () => {
  const closed = [1, 2, 3, 4].map((n) =>
    makeJob({ id: `job-c${n}`, title: `Closed ${n}`, state: 'closed' }),
  )
  renderInRoom(
    <ChatInfo
      room={room}
      agents={agents}
      jobs={[defaultJob, makeJob({ id: 'job-1', title: 'Activity feed' }), ...closed]}
      everyone
    />,
  )
  const past = screen.getByRole('heading', { name: /Past jobs/ }).closest('section')!
  expect(past.querySelectorAll('li a').length).toBe(4)
  expect(document.querySelector('details.bold-chat-closed')).toBeNull()
})

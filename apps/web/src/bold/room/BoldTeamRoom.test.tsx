import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useSearchParams } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
  room,
} from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

function stubRoom(jobs = [makeJob({ unread: 2 })]) {
  const fetchMock = mockFetch((url) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/team-room') return jsonResponse({ asOfSeq: 1, room, jobs })
    if (parsed.pathname === '/api/rooms/room-1/jobs')
      return jsonResponse({ asOfSeq: 1, items: jobs })
    if (parsed.pathname === '/api/rooms/room-1/messages')
      return jsonResponse({
        asOfSeq: 1,
        items: [],
        nextCursor: null,
        jobId: parsed.searchParams.get('jobId'),
      })
    if (parsed.pathname === '/api/rooms/room-1/pins') return jsonResponse({ items: [] })
    if (parsed.pathname === '/api/rooms/room-1/versions')
      return jsonResponse({ asOfSeq: 1, items: [] })
    if (parsed.pathname === '/api/approvals') return jsonResponse({ asOfSeq: 1, items: [] })
    if (parsed.pathname === '/api/commands') return jsonResponse({ items: [] })
    if (parsed.pathname.startsWith('/api/jobs/')) return jsonResponse({ asOfSeq: 1, items: [] })
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function ParamsProbe() {
  const [params] = useSearchParams()
  return <span data-testid="params">{params.toString()}</span>
}

test('a slash command handed over in the URL is loaded into the room composer and removed from the URL', async () => {
  stubRoom()
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?command=assign'],
  )
  const composer = await screen.findByRole(
    'combobox',
    { name: /^Message Team room/ },
    { timeout: 4000 },
  )
  await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('/assign '), {
    timeout: 4000,
  })
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('command'), {
    timeout: 4000,
  })
})

test('the room shows job tabs, the To chip and the seeded unread count', async () => {
  stubRoom([
    makeJob({ id: 'job-1', title: 'Activity feed', unread: 2 }),
    makeJob({ id: 'job-2', title: 'Release notes', unread: 3 }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('tab', { name: /Activity feed/ })
  expect(screen.getByRole('tab', { name: /^All/ }).textContent).toContain('5')
  expect(screen.getByText('To: team room (lead)')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Needs you' })).toBeDefined()
})

test('selecting a job changes the composer destination and hides the message param', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-1&message=old'])
  expect(await screen.findByText('To: Activity feed')).toBeDefined()
  fireEvent.click(screen.getByRole('tab', { name: /^All/ }))
  expect(await screen.findByText('To: team room (lead)')).toBeDefined()
})

test('opening the room reads only the jobs on screen, and a second job waits for its tab', async () => {
  const activity = makeJob({ id: 'job-activity', title: 'Activity feed', unread: 4 })
  const defaultJob = makeJob({
    id: 'job-default',
    title: 'Team room',
    isDefault: true,
    unread: 0,
  })
  const fetchMock = stubRoom([defaultJob, activity])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  const activityTab = await screen.findByRole('tab', { name: /Activity feed/ })
  expect(activityTab.textContent).toContain('4')
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-default'),
      ),
    ).toBe(true),
  )
  expect(
    fetchMock.mock.calls.some(
      ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-activity'),
    ),
  ).toBe(false)

  fireEvent.click(screen.getByRole('tab', { name: /Activity feed/ }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/messages?') && String(url).includes('jobId=job-activity'),
      ),
    ).toBe(true),
  )
})

test('a fresh team room shows board 09 and a starter fills the composer', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  expect(
    await screen.findByRole('heading', { name: 'Your team is ready. What first?' }),
  ).toBeDefined()
  expect(screen.queryByRole('tablist', { name: 'Jobs' })).toBeNull()
  expect(screen.queryByText('Show deleted messages')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Build something, reviewed/ }))
  const composer = screen.getByRole('combobox', { name: /^Message Team room/ })
  await waitFor(() =>
    expect((composer as HTMLTextAreaElement).value).toBe(
      'Build a small feature and have reviewer check it.',
    ),
  )
})

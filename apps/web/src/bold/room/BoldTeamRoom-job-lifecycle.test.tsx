import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom, room } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { JobUndoToast } from './JobUndoToast.tsx'
import { lastRequest, ParamsProbe, setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/** One job per chat (3.28.0): the job bar carries the job's ⋯ menu now that its divider is gone. */
function jobBar() {
  return screen.getByRole('region', { name: 'Current job' })
}

// was: 'opening the room reads only the jobs on screen, and a second job waits for its tab'
test('opening the room reads the whole chat in one chain, not one read per topic', async () => {
  const fetchMock = stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-activity', title: 'Activity feed', unread: 4 }),
    makeJob({ id: 'job-notes', title: 'Release notes', unread: 1 }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  const reads = () =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/rooms/room-1/messages?'))
  await waitFor(() => expect(reads().some((url) => url.includes('all=1'))).toBe(true))
  expect(reads().every((url) => url.includes('all=1'))).toBe(true)
  expect(reads().some((url) => url.includes('jobId='))).toBe(false)
})

// 3.24.0: the chat header has Chat info and no "+ Job"; Start a run lives in the composer's + menu.
test('the team room header has no + Job button; the composer’s + menu offers Start a run', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])

  await screen.findByRole('combobox', { name: /^Message Team room/ })
  expect(screen.queryByRole('button', { name: 'Start a job' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Attach, voice and commands' }))
  expect(await screen.findByRole('button', { name: 'Start a run…' })).toBeDefined()
})

// was: 'the room dropdown opens an older room read-write with today’s @mention routing'
test('an older room opens read-write with today’s @mention routing', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])

  expect(await screen.findByText('Older room')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Start a job' })).toBeNull()
  const composer = await screen.findByRole('combobox', { name: /^Message #activity-feed/ })
  fireEvent.change(composer, { target: { value: '@builder Where is the feed?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  await waitFor(() => {
    const sent = lastRequest(fetchMock, '/api/rooms/room-old/messages', 'POST')
    expect(sent).toBeDefined()
    expect(JSON.parse(String(sent?.[1]?.body))).toMatchObject({
      text: '@builder Where is the feed?',
    })
  })
})

// was: 'rename sends PATCH with the trimmed title'
test('renaming the job from its bar menu sends PATCH with the trimmed title and relabels the bar', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity' && init?.method === 'PATCH')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed v2' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: '  Activity feed v2  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  await waitFor(() =>
    expect(lastRequest(fetchMock, '/api/jobs/job-activity', 'PATCH')).toBeDefined(),
  )
  expect(
    JSON.parse(String(lastRequest(fetchMock, '/api/jobs/job-activity', 'PATCH')![1]!.body)),
  ).toEqual({
    title: 'Activity feed v2',
  })
  expect(await screen.findByText('Renamed “Activity feed v2”.')).toBeDefined()
  expect(within(jobBar()).getByText('Activity feed v2')).toBeDefined()
  expect(within(jobBar()).queryByText('Activity feed')).toBeNull()
})

// was: 'delete asks for the typed title, then offers a 10-second undo that restores'
test('deleting the job asks for its typed title, takes its bar away, and Undo brings it back', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return new Response(null, { status: 204 })
    if (url === '/api/jobs/job-activity/restore' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed' }))
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <JobUndoToast />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  const confirm = screen.getByRole('button', { name: 'Delete job' })
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  expect((confirm as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(confirm)
  expect(await screen.findByText(/Job deleted/)).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(lastRequest(fetchMock, '/api/jobs/job-activity/restore', 'POST')).toBeDefined(),
  )
  expect(await screen.findByText('Restored “Activity feed”.')).toBeDefined()
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Activity feed'),
  ).toBeDefined()
})

// was: 'closing a job posts close and tells the person where to find it'
test('closing the job posts close, says how to reopen it, and it reads as a past job', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-activity/close' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  await screen.findByRole('region', { name: 'Current job' })

  fireEvent.click(within(jobBar()).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))

  expect(await screen.findByText('Closed “Activity feed”. Reopen it from its menu.')).toBeDefined()
  // It stays reachable as a closed past job: nothing disappears into a hidden list.
  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Activity feed')
  expect(past.textContent).toContain('Closed')
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  const call = lastRequest(fetchMock, '/api/jobs/job-activity/close', 'POST')
  expect(call).toBeDefined()
  expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toBeTruthy()
})

// was: 'a closed job is listed under Closed jobs and its menu reopens it'
test('a past job opened from Info shows its own bar, and its menu reopens it', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-closed/reopen' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-closed', title: 'Old import', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-closed'])

  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Old import')
  expect(past.textContent).toContain('opened read-only')
  expect(within(past).queryByRole('button', { name: 'Stop job' })).toBeNull()
  fireEvent.click(within(past).getByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reopen' }))

  expect(await screen.findByText('Reopened “Old import”.')).toBeDefined()
  // Reopened, it is the chat's one active job: the Current job bar replaces the past one.
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Old import'),
  ).toBeDefined()
  expect(lastRequest(fetchMock, '/api/jobs/job-closed/reopen', 'POST')).toBeDefined()
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
})

// was: 'a closed job from the server snapshot is under Closed jobs after a reload'
test('a job closed in the server snapshot is a past job beside the running one: the running job keeps its bar', async () => {
  const closed = makeJob({ id: 'job-closed', title: 'Old import', state: 'closed' })
  stubRoom([closed, makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-closed'])

  const past = await screen.findByRole('region', { name: 'Past job' })
  expect(past.textContent).toContain('Closed')
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Activity feed'),
  ).toBeDefined()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(within(past).getByRole('button', { name: 'Job menu' })).toBeDefined()
})

// was: 'a job.deleted event returns the open job to All with a note'
test('a job.deleted event takes the open job out of the conversation, clears ?job= and says why', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes' }),
  ])
  const view = renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })

  view.emit({
    seq: 2,
    ts: '2026-10-24T10:00:00.000Z',
    type: 'job.deleted',
    data: { id: 'job-activity', roomId: room.id },
  })

  expect(await screen.findByText('That job was deleted.')).toBeDefined()
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('job='))
  expect(screen.queryByRole('separator', { name: /^Topic: Activity feed/ })).toBeNull()
  // One job is left, so the chat drops its dividers and shows Release notes on the bar.
  expect(screen.queryByRole('separator')).toBeNull()
  expect(
    within(await screen.findByRole('region', { name: 'Current job' })).getByText('Release notes'),
  ).toBeDefined()
})

// was: 'a job.deleted event returns an open phone job to the list with a note'
test('a job.deleted event returns an open phone topic to the chat with a note', async () => {
  stubRoom([
    makeJob({ id: 'job-activity', title: 'Activity feed' }),
    makeJob({ id: 'job-notes', title: 'Release notes' }),
  ])
  const view = renderInRoom(
    <>
      <BoldTeamRoom agents={agents} phone />
      <ParamsProbe />
    </>,
    ['/b?job=job-activity'],
  )
  await screen.findByRole('button', { name: 'Back to chats' })

  view.emit({
    seq: 2,
    ts: '2026-10-24T10:00:00.000Z',
    type: 'job.deleted',
    data: { id: 'job-activity', roomId: room.id },
  })

  expect(await screen.findByText('That job was deleted.')).toBeDefined()
  await waitFor(() => expect(screen.getByTestId('params').textContent).not.toContain('job='))
  expect(screen.getByRole('button', { name: 'Back to chats' })).toBeDefined()
})

// was: 'a room whose messages were all deleted offers the real toggle on the starter board'
test('a room whose messages were all deleted offers Show deleted messages in the room ⋯ menu, which hides the starter board', async () => {
  stubRoom([], {
    versions: [
      {
        id: 'v1',
        roomId: 'room-1',
        anchorId: 'm1',
        anchorCreatedAt: '2026-10-24T10:00:00.000Z',
        mode: 'delete',
        replacedBy: null,
        number: 1,
        count: 1,
        hiddenCount: 1,
        rewound: [],
        skipped: [],
        createdAt: '2026-10-24T10:01:00.000Z',
      },
    ],
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  // Nothing sits above the conversation: the toggle is not a link on the board any more.
  await screen.findByRole('heading', { name: 'Your team is ready. What first?' })
  expect(screen.queryByRole('button', { name: 'Show deleted messages' })).toBeNull()

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const show = await screen.findByRole('menuitemcheckbox', { name: 'Show deleted messages' })
  expect(show.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(show)
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Your team is ready. What first?' })).toBeNull(),
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const hide = await screen.findByRole('menuitemcheckbox', { name: 'Hide deleted messages' })
  expect(hide.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(hide)
  expect(
    await screen.findByRole('heading', { name: 'Your team is ready. What first?' }),
  ).toBeDefined()
})

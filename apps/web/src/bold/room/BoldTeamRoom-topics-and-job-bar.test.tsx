import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import {
  lastRequest,
  ParamsProbe,
  phoneApproval,
  setupRoomTest,
  stubRoom,
} from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

// 3.22.0: the job tabs and filters are gone; the chat is one conversation with a divider per topic. Each test below
// replaces one the stage-2 rewrite removed, and checks the new behaviour of the same promise.

// was: 'the room shows job tabs, the To chip and the seeded unread count'
test('the room shows one divider per topic (no tabs or filter chips) and the context bar names the current one', async () => {
  stubRoom([
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      unread: 2,
      createdAt: '2026-10-24T09:00:00.000Z',
    }),
    makeJob({
      id: 'job-2',
      title: 'Release notes',
      unread: 3,
      createdAt: '2026-10-24T09:30:00.000Z',
    }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('separator', { name: 'Topic: Activity feed, working' })
  expect(screen.getByRole('separator', { name: 'Topic: Release notes, working' })).toBeDefined()
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByRole('tab')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Needs you' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Closed jobs' })).toBeNull()
  // The newest open topic is current, so a message goes there.
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('To')
  expect(bar.textContent).toContain('lead')
  expect(bar.textContent).toContain('in Release notes')
})

// 3.24.0: the All topics screen is gone. Was: 'a phone’s All topics list puts the pinned request first, then the general
// conversation and the topics with their unread counts'. The request now sits in the conversation.
test('a phone opens straight into the conversation, with the needs-you card inside it and no All topics screen', async () => {
  stubRoom(
    [
      makeJob({ id: 'job-default', title: 'Team room', isDefault: true, unread: 9 }),
      makeJob({ id: 'job-activity', title: 'Activity feed', unread: 2 }),
    ],
    { approvals: [phoneApproval] },
  )
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?jobs=1'])

  const pin = await screen.findByRole('article', {
    name: /Needs you: May I install a package/,
  })
  expect(pin.getAttribute('data-protected')).toBe('flex')
  expect(pin.closest('.bold-stream')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'All topics' })).toBeNull()
  expect(await screen.findByRole('combobox', { name: /^Message Team room/ })).toBeDefined()
})

// 3.24.0: was 'a missing phone topic shows All topics with a short note, never a Back header' and '…in a fresh room
// still shows All topics, not the starter': the note stays, the conversation shows instead of a list.
test('a missing phone topic says so and shows the conversation, never a list or a Back header', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
  expect(await screen.findByRole('combobox', { name: /^Message / })).toBeDefined()
})

test('a missing phone topic in a fresh room says so, with no list', async () => {
  stubRoom([])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-deleted'])

  expect(await screen.findByText('That job isn’t here any more.')).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'All topics' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back to jobs' })).toBeNull()
})

// was: 'selecting a job changes the composer destination and hides the message param'
test('one job per chat: the context bar says only who it goes to, and a message goes to the active job, else the chat’s own thread', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({
      id: 'job-old',
      title: 'Old work',
      state: 'done',
      createdAt: '2026-10-24T08:00:00.000Z',
    }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
  ])
  // A finished job opened from Past jobs is read-only: the message still goes to the chat's active job.
  const first = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-old&message=old'])
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('lead')
  expect(bar.textContent).not.toContain(' in ')
  first.unmount()

  const second = renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByRole('region', { name: 'Current job' })
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
  second.unmount()

  // With every job finished, a message goes to the chat's own thread: no bar, no "in …".
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-old', title: 'Old work', state: 'done' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await screen.findByLabelText('Where this message goes')
  expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull()
  expect(screen.queryByRole('separator')).toBeNull()
  expect(screen.getByLabelText('Where this message goes').textContent).not.toContain(' in ')
})

test('an older chat that still holds several active jobs keeps choosing: the context bar names the newest open one', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
    makeJob({ id: 'job-2', title: 'Release notes', createdAt: '2026-10-24T09:30:00.000Z' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await waitFor(() =>
    expect(screen.getByLabelText('Where this message goes').textContent).toContain(
      'in Release notes',
    ),
  )
  // 3.30.0: the bar is the newest active job's, with "+N more open"; the dividers stay for the rest.
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(within(bar).getByText('Release notes')).toBeDefined()
  expect(within(bar).getByRole('button', { name: '+1 more open' })).toBeDefined()
  expect(screen.getAllByRole('separator').length).toBeGreaterThan(1)
})

test('"+N more open" on an older chat’s bar asks for Info’s Open jobs', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', createdAt: '2026-10-24T09:00:00.000Z' }),
    makeJob({ id: 'job-2', title: 'Release notes', createdAt: '2026-10-24T09:30:00.000Z' }),
    makeJob({ id: 'job-3', title: 'Docs', createdAt: '2026-10-24T09:40:00.000Z' }),
  ])
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <ParamsProbe />
    </>,
    ['/b'],
  )
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(within(bar).getByText('Docs')).toBeDefined()
  fireEvent.click(within(bar).getByRole('button', { name: '+2 more open' }))
  await waitFor(() => expect(screen.getByTestId('params').textContent).toContain('jobs=open'))
})

test('a job waiting on you says so in its bar with a protected Needs you pill', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', state: 'waiting_on_you', needsYou: true }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  const pill = within(bar).getByRole('button', { name: /needs you/i })
  expect(pill.getAttribute('data-protected')).toBe('inline-flex')
  expect(pill.textContent).toBe('Needs you')
  // Tapping with no card in view does nothing and breaks nothing.
  fireEvent.click(pill)
  expect(screen.getByRole('region', { name: 'Current job' })).toBeDefined()
  cleanup()
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const working = await screen.findByRole('region', { name: 'Current job' })
  expect(within(working).queryByText('Needs you')).toBeNull()
})

test('the job bar shows only with an active job, with its title, state line and Stop job', async () => {
  stubRoom([
    makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      holderAgentId: 'builder',
      activeAgents: ['builder'],
      spendCapUsd: 5,
    }),
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  expect(bar.getAttribute('data-protected')).toBe('block')
  expect(bar.textContent).toContain('JOB')
  expect(within(bar).getByText('Activity feed').getAttribute('title')).toBe('Activity feed')
  expect(bar.textContent).toContain('builder is working')
  expect(bar.textContent).toContain('cap $5.00')
  expect(within(bar).getByRole('button', { name: 'Stop job' })).toBeDefined()
  // No run, no Graph.
  expect(within(bar).queryByRole('button', { name: 'Graph' })).toBeNull()
  // One job: no divider in the stream.
  expect(screen.queryByRole('separator')).toBeNull()
})

test('a job with a run shows Graph on the bar, which opens the side panel’s Graph tab for it', async () => {
  stubRoom([
    makeJob({
      id: 'job-1',
      title: 'Activity feed',
      recipe: { kind: 'orchestration', ref: 'orch-1' },
    }),
  ])
  const shown: string[] = []
  renderInRoom(<BoldTeamRoom agents={agents} onShowGraph={(id) => shown.push(id)} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(bar).getByRole('button', { name: 'Graph' }))
  expect(shown).toEqual(['job-1'])
})

test('Stop job on the bar asks first, then ends the job; Keep going leaves it running', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input) === '/api/jobs/job-1/end' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-1', title: 'Activity feed', state: 'closed' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const bar = await screen.findByRole('region', { name: 'Current job' })
  fireEvent.click(within(bar).getByRole('button', { name: 'Stop job' }))
  const confirm = screen.getByRole('alertdialog', { name: 'Stop Activity feed?' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  expect(confirm.textContent).toContain('Stop “Activity feed”?')
  expect(confirm.textContent).toContain(
    'Running steps stop and the job closes. What it made stays in Past jobs.',
  )
  // Keep going closes the confirm and sends nothing.
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep going' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeUndefined()

  fireEvent.click(within(bar).getByRole('button', { name: 'Stop job' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop job' }))
  await waitFor(() => expect(lastRequest(fetchMock, '/api/jobs/job-1/end', 'POST')).toBeDefined())
  // The job is closed: its bar goes, and the result stays where it was.
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Current job' })).toBeNull())
  const note = await screen.findByText('Stopped “Activity feed”. It’s in Past jobs.')
  expect(note.getAttribute('role')).toBe('status')
})

test('Next up shows a queued trigger call under the bar, and Skip drops it', async () => {
  const queue = {
    asOfSeq: 1,
    items: [
      {
        id: 'q-1',
        roomId: 'room-1',
        title: 'Nightly report',
        source: { app: 'schedule', ref: 'nightly', title: null, triggerId: 'trg-1' },
        createdAt: '2026-10-24T09:10:00.000Z',
      },
    ],
  }
  let skipped = false
  const fetchMock = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/rooms/room-1/queue/q-1' && init?.method === 'DELETE') {
      skipped = true
      return new Response(null, { status: 204 })
    }
    if (url === '/api/rooms/room-1/queue')
      return jsonResponse(skipped ? { asOfSeq: 2, items: [] } : queue)
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const next = await screen.findByRole('region', { name: 'Next up' })
  expect(next.getAttribute('data-protected')).toBe('block')
  expect(next.textContent).toContain('Next up:')
  expect(next.textContent).toContain('“Nightly report” from schedule waits until this job ends.')
  fireEvent.click(within(next).getByRole('button', { name: /^Skip/ }))
  await waitFor(() => expect(skipped).toBe(true))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Next up' })).toBeNull())
})

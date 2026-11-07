import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, jsonResponse, makeJob, makeMessage, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { JobUndoToast } from './JobUndoToast.tsx'
import { setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

test('the selected job’s menu offers rename, close, share, export and delete, but not for the room’s own thread', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  const menu = await screen.findByRole('menu', { name: 'Activity feed actions' })
  expect(menu.textContent).toContain('Rename…')
  expect(menu.textContent).toContain('Close')
  expect(menu.textContent).toContain('Share a read-only link')
  expect(menu.textContent).toContain('Export the whole room as Markdown')
  expect(menu.textContent).toContain('Delete job')
  expect(screen.getAllByRole('menuitem').every((item) => item.classList.contains('mi'))).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share a read-only link' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Share Activity feed')
  expect(dialog.textContent).toContain('the job’s messages')
})

test('a close while work is running explains the 409 and offers Stop', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity/close' && init?.method === 'POST')
      return jsonResponse(
        {
          error: {
            code: 'conflict',
            message: 'The job is still working. Stop it first, then close it.',
          },
        },
        409,
      )
    if (url === '/api/jobs/job-activity/stop' && init?.method === 'POST')
      return jsonResponse({ ok: true })
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Close' }))
  expect(
    await screen.findByText(/This job is still working\. Stop it first, then close it\./),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/jobs/job-activity/stop'),
    ).toBe(true),
  )
  expect(await screen.findByText(/Stop sent\. Close or delete the job again/)).toBeDefined()
})

test('a restore failure clears the undo toast and names the reason', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return new Response(null, { status: 204 })
    if (url === '/api/jobs/job-activity/restore' && init?.method === 'POST')
      return jsonResponse({ error: { code: 'not_found', message: 'The job is gone.' } }, 404)
    return fallback(input, init)
  })
  renderInRoom(
    <>
      <BoldTeamRoom agents={agents} />
      <JobUndoToast />
    </>,
    ['/b?job=job-activity'],
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete job' }))
  expect(await screen.findByText(/Job deleted/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

  expect(await screen.findByText('That job can’t be restored any more')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
})

test('the default job offers neither rename nor delete', async () => {
  stubRoom([makeJob({ id: 'job-default', title: 'Team room', isDefault: true })])
  renderInRoom(<BoldTeamRoom agents={agents} phone />, ['/b?job=job-default'])
  // The conversation itself has no job tools on a phone: nothing to rename or delete (named jobs keep their menu).
  expect(await screen.findByRole('button', { name: 'Back to chats' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Job menu' })).toBeNull()
})

test('a message into a closed job explains the 409, and Reopen resends into that job', async () => {
  let sends = 0
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/rooms/room-1/messages' && init?.method === 'POST') {
      sends += 1
      if (sends === 1)
        return jsonResponse(
          { error: { code: 'conflict', message: 'This job is closed. Reopen it first.' } },
          409,
        )
      return jsonResponse({
        message: makeMessage({
          id: 'message-resumed',
          jobId: 'job-activity',
          parts: [{ kind: 'text', text: 'One more change' }],
        }),
        routedTo: ['builder'],
        command: null,
      })
    }
    if (url === '/api/jobs/job-activity/reopen' && init?.method === 'POST')
      return jsonResponse(makeJob({ id: 'job-activity', title: 'Activity feed', state: 'open' }))
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: 'One more change' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText('This job is closed. Reopen it to write in it.')).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
  await waitFor(() => expect(sends).toBe(2))
  const posts = fetchMock.mock.calls.filter(
    ([url, init]) => String(url) === '/api/rooms/room-1/messages' && init?.method === 'POST',
  )
  expect(posts.map(([, init]) => JSON.parse(String(init?.body)).jobId)).toEqual([
    'job-activity',
    'job-activity',
  ])
  expect(new Headers(posts[0]![1]!.headers).get('Idempotency-Key')).toBe(
    new Headers(posts[1]![1]!.headers).get('Idempotency-Key'),
  )
})

test('delete explains a still-working 409 and offers Stop', async () => {
  const fetchMock = stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/jobs/job-activity' && init?.method === 'DELETE')
      return jsonResponse(
        {
          error: {
            code: 'conflict',
            message: 'The job is still working. Stop it first, then delete it.',
          },
        },
        409,
      )
    if (url === '/api/jobs/job-activity/stop' && init?.method === 'POST')
      return jsonResponse({ ok: true })
    return fallback(input, init)
  })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  fireEvent.click(await screen.findByRole('button', { name: 'Job menu' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete job' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Activity feed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Delete job' }))
  expect(await screen.findByText(/still working\. Stop it first, then delete it/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/jobs/job-activity/stop'),
    ).toBe(true),
  )
})

test('the team room’s share uses the selected job thread and says what All shares', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  expect(
    await screen.findByText(
      /Shares the selected job’s thread; under All, the team room’s default thread/,
    ),
  ).toBeDefined()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Share a read-only link' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('Share Activity feed')
  expect(dialog.textContent).toContain('the job’s messages')
})

test('the room menu gives export, share and delete the prototype’s menu rows', async () => {
  stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })], { older: true })
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?room=room-old'])

  fireEvent.click(await screen.findByRole('button', { name: 'Room menu' }))
  const menu = await screen.findByRole('menu', { name: '#activity-feed actions' })
  expect(menu.textContent).toContain('Export this room')
  expect(menu.textContent).toContain('Share a read-only link')
  expect(menu.textContent).toContain('Delete #activity-feed')
  expect(
    [...menu.querySelectorAll('[role="menuitem"]')].every((item) => item.classList.contains('mi')),
  ).toBe(true)
  expect(menu.getAttribute('data-protected')).toBe('flex')
})

test('Team lead… opens from the team room menu and Cancel gives focus back to the menu button', async () => {
  stubRoom([makeJob({ id: 'job-activity', title: 'Activity feed' })])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b?job=job-activity'])
  const trigger = await screen.findByRole('button', { name: 'Room menu' })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Team lead…' }))
  await screen.findByRole('dialog', { name: 'Team lead' })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Team lead' })).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

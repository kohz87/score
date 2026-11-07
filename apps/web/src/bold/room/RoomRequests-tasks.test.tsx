import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, jsonResponse, makeTask, renderInRoom } from './room-test-utils.tsx'
import { roomTasksQuery } from './task-queries.ts'
import { approval, job, setupRoomRequestsTest, stubRoom } from './RoomRequests-helpers.tsx'
import { RoomRequests } from './RoomRequests.tsx'

setupRoomRequestsTest()

test('a room’s blocked task is a protected card; unblock takes an optional note', async () => {
  const task = makeTask()
  const fetchMock = stubRoom(null, approval, Promise.resolve(), false, [task])
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" messages={[]} />,
  )

  const card = await screen.findByRole('article', {
    name: `Needs you: Blocked task: ${task.title}`,
  })
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(card.textContent).toContain('TASK-1')
  expect(card.textContent).toContain('Needs a decision on the timeout')
  expect(card.textContent).toContain('builder')

  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  const form = within(card).getByLabelText('Note (optional)') as HTMLTextAreaElement
  fireEvent.change(form, { target: { value: 'Use a 30 second timeout.' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST',
  )!
  expect(JSON.parse(String(call[1]!.body))).toEqual({
    action: 'unblock',
    text: 'Use a 30 second timeout.',
  })
  expect(new Headers(call[1]!.headers).get('Idempotency-Key')).toBeTruthy()
})

test('a comment needs text, and the task leaves when the stream says it is no longer blocked', async () => {
  const task = makeTask()
  const fetchMock = stubRoom(null, approval, Promise.resolve(), false, [task])
  const mounted = renderInRoom(
    <RoomRequests
      roomId="room-1"
      jobs={[job]}
      agents={agents}
      selectedJob="all"
      messages={[]}
      teamRoom
    />,
  )
  const card = await screen.findByRole('article', {
    name: `Needs you: Blocked task: ${task.title}`,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Comment' }))
  const send = within(card).getByRole('button', { name: 'Comment' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(within(card).getByLabelText(`Comment on ${task.title}`), {
    target: { value: 'Check the staging logs.' },
  })
  expect(send.disabled).toBe(false)
  fireEvent.click(send)
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST',
  )!
  expect(JSON.parse(String(call[1]!.body))).toEqual({
    action: 'comment',
    text: 'Check the staging logs.',
  })

  act(() =>
    mounted.emit({
      seq: 2,
      ts: '2026-10-24T09:07:00.000Z',
      type: 'task.upserted',
      data: makeTask({ column: 'working', hermesStatus: 'running', badge: null }),
    }),
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('article', { name: `Needs you: Blocked task: ${task.title}` }),
    ).toBeNull(),
  )
})

test('a task action says it is waiting for Hermes and keeps its key across a network retry', async () => {
  const task = makeTask()
  let attempts = 0
  const fetchMock = stubRoom(null, approval, Promise.resolve(), false, [task])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/api/tasks/task-1/actions' && init?.method === 'POST') {
      attempts += 1
      if (attempts === 1) throw new Error('connection dropped')
      return jsonResponse({ ok: true })
    }
    return fallback(url, init)
  })
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" messages={[]} />,
  )
  const card = await screen.findByRole('article', {
    name: `Needs you: Blocked task: ${task.title}`,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  expect(await within(card).findByText(/Couldn’t unblock this task/)).toBeDefined()
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))

  expect(await within(card).findByText('Sent — waiting for Hermes')).toBeDefined()
  expect((within(card).getByRole('button', { name: 'Sent' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  const keys = fetchMock.mock.calls
    .filter(([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST')
    .map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
})

test('a task action uses a fresh key after a 4xx', async () => {
  const task = makeTask()
  let attempts = 0
  const fetchMock = stubRoom(null, approval, Promise.resolve(), false, [task])
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/api/tasks/task-1/actions' && init?.method === 'POST') {
      attempts += 1
      if (attempts === 1)
        return jsonResponse({ error: { code: 'conflict', message: 'Try again.' } }, 409)
      return jsonResponse({ ok: true })
    }
    return fallback(url, init)
  })
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" messages={[]} />,
  )
  const card = await screen.findByRole('article', {
    name: `Needs you: Blocked task: ${task.title}`,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  expect(await within(card).findByText('Try again.')).toBeDefined()
  fireEvent.click(within(card).getByRole('button', { name: 'Unblock' }))
  expect(await within(card).findByText('Sent — waiting for Hermes')).toBeDefined()

  const keys = fetchMock.mock.calls
    .filter(([url, init]) => String(url) === '/api/tasks/task-1/actions' && init?.method === 'POST')
    .map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe(keys[1])
})

test('only the team room includes a blocked task with no room', async () => {
  const unassigned = makeTask({ id: 'task-unassigned', roomId: null })
  stubRoom(null, approval, Promise.resolve(), false, [unassigned])

  const roomView = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" messages={[]} />,
  )
  await waitFor(() =>
    expect(
      roomView.queryClient.getQueryData(roomTasksQuery('room-1', false, true).key),
    ).toBeDefined(),
  )
  expect(
    screen.queryByRole('article', { name: /task-unassigned|Fix the login timeout/ }),
  ).toBeNull()
  roomView.unmount()

  renderInRoom(
    <RoomRequests
      roomId="room-1"
      jobs={[job]}
      agents={agents}
      selectedJob="all"
      messages={[]}
      teamRoom
    />,
  )
  expect(
    await screen.findByRole('article', { name: `Needs you: Blocked task: ${unassigned.title}` }),
  ).toBeDefined()
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Room, TaskDetail } from '@score/contract'
import { NewTaskDialog } from './NewTaskDialog.tsx'

const at = '2026-10-08T12:00:00.000Z'
const agents: AgentSummary[] = [
  {
    id: 'builder',
    name: 'Builder',
    role: 'Builds it',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  },
]
const rooms: Room[] = [
  {
    id: 'room-feed',
    name: '#activity-feed',
    kind: 'room',
    leadAgentId: 'lead',
    members: ['builder'],
    unread: 0,
    activeAgents: [],
    channels: [],
  },
]
const created: TaskDetail = {
  id: 't1',
  key: 'T-1',
  title: 'Ship it',
  column: 'planned',
  hermesStatus: 'ready',
  assignee: 'builder',
  reviewer: null,
  roomId: 'room-feed',
  badge: null,
  progress: null,
  elapsedSec: null,
  note: null,
  updatedAt: at,
  body: '',
  createdBy: 'you',
  steps: [],
  activity: [],
  pendingApproval: null,
  dependsOn: [],
  blocks: [],
  runIds: [],
}
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const mount = (onCreated = vi.fn(), close = vi.fn()) => {
  render(
    <NewTaskDialog
      agents={agents}
      rooms={rooms}
      defaultRoom=""
      close={close}
      created={onCreated}
    />,
  )
  return { onCreated, close }
}
const keyOf = (call: number) =>
  new Headers(fetchMock.mock.calls[call]![1]!.headers).get('Idempotency-Key')

test('posts title, details, assignee, room and steps with an Idempotency-Key', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(created)))
  const { onCreated } = mount()
  const submit = screen.getByRole('button', { name: 'Create task' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' Ship it ' } })
  fireEvent.change(screen.getByLabelText('Details'), { target: { value: 'Before Friday' } })
  fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'builder' } })
  fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'room-feed' } })
  fireEvent.change(screen.getByLabelText(/^Steps/), { target: { value: 'Write\n\n  Test  \n' } })
  fireEvent.click(submit)
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
  const [path, init] = fetchMock.mock.calls[0]!
  expect(path).toBe('/api/tasks')
  expect(init!.method).toBe('POST')
  expect(JSON.parse(init!.body as string)).toEqual({
    title: 'Ship it',
    body: 'Before Friday',
    assignee: 'builder',
    roomId: 'room-feed',
    steps: ['Write', 'Test'],
  })
  expect(keyOf(0)).toBeTruthy()
})

test('only the title is required; optional fields are left out', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(created)))
  mount()
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Just a title' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ title: 'Just a title' })
})

test('a failure shows the message, keeps the form, and retries with the same key until edited', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'conflict', message: 'Hermes said no' } }), {
        status: 409,
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'conflict', message: 'Still no' } }), {
        status: 409,
      }),
    )
    .mockResolvedValue(new Response(JSON.stringify(created)))
  const { onCreated } = mount()
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Hermes said no')
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Ship it')
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await screen.findByText('Still no')
  expect(keyOf(1)).toBe(keyOf(0))
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it now' } })
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
  await waitFor(() => expect(onCreated).toHaveBeenCalled())
  expect(keyOf(2)).not.toBe(keyOf(0))
})

test('close and Escape hand control back', () => {
  const { close } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
  expect(close).toHaveBeenCalledTimes(2)
})

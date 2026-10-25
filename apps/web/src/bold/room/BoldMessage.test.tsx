import type { Message } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useEditing, stopEdit } from '../../routes/chat/message-edit.ts'
import { BoldMessage } from './BoldMessage.tsx'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'

afterEach(() => {
  stopEdit()
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const reply = makeMessage({
  id: 'reply-1',
  author: { kind: 'agent', agentId: 'builder' },
  parts: [{ kind: 'text', text: 'Read layer is ready.' }],
})
const mine = makeMessage({ id: 'mine-1', parts: [{ kind: 'text', text: 'Add ws.' }] })

function EditingProbe() {
  const editing = useEditing()
  return <output data-testid="editing">{editing?.messageId ?? ''}</output>
}

function renderMessage(
  message: Message,
  extra: { pinned?: boolean; canRetry?: boolean; onEdit?: () => void } = {},
) {
  const fetchMock = mockFetch((_url, init) =>
    init.method === 'POST' ? jsonResponse({}) : new Response(null, { status: 204 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const onTogglePin = vi.fn()
  renderInRoom(
    <>
      <BoldMessage
        message={message}
        agents={agents}
        versions={[]}
        onView={() => undefined}
        pinned={extra.pinned ?? false}
        pinBusy={false}
        onTogglePin={onTogglePin}
        className="bold-dm-message"
        canRetry={extra.canRetry ?? false}
        {...(extra.onEdit ? { onEdit: extra.onEdit } : {})}
      />
      <EditingProbe />
    </>,
  )
  return { fetchMock, onTogglePin }
}

// The row's own buttons (MessageItem has its own controls too).
const acts = () => [...document.querySelectorAll<HTMLElement>('.bold-acts .bold-act')]
const names = () => acts().map((button) => button.getAttribute('aria-label') ?? '')
const act = (name: string) => {
  const found = acts().find((button) => button.getAttribute('aria-label') === name)
  if (!found) throw new Error(`No action named ${name}`)
  return found
}

test('the wrapper carries the place’s class and the action row is a keyboard-reachable group', () => {
  renderMessage(mine)
  const wrapper = document.querySelector('.bold-message.bold-dm-message')
  expect(wrapper?.getAttribute('data-message-id')).toBe('mine-1')
  expect(wrapper?.getAttribute('tabindex')).toBe('0')
  expect(
    document
      .querySelector('.bold-acts[aria-label="Actions for message from You"]')
      ?.getAttribute('role'),
  ).toBe('group')
})

test('your own finished message has Edit, Copy, Pin and Delete, and no Retry', () => {
  renderMessage(mine)
  expect(names()).toEqual([
    'Edit message from You',
    'Copy message from You',
    'Pin message from You',
    'Delete message from You',
  ])
})

test('an agent reply to the person has Retry and Delete and no Edit', () => {
  renderMessage(reply, { canRetry: true })
  const labels = names()
  expect(labels).toContain('Retry reply from builder')
  expect(labels).toContain('Delete message from builder')
  expect(labels.some((label) => label.startsWith('Edit'))).toBe(false)
})

test('an edited message of yours cannot be edited again', () => {
  renderMessage({ ...mine, editedBy: 'mine-2' } as Message)
  expect(names().some((label) => label.startsWith('Edit'))).toBe(false)
})

test('an imported message has no Edit, Retry, Pin or Delete', () => {
  renderMessage({ ...reply, id: 'import:abc' })
  expect(names()).toEqual(['Copy message from builder', 'Save message from builder to Library'])
})

test('a message still being written has no action row', () => {
  renderMessage({ ...reply, streaming: true })
  expect(document.querySelector('.bold-acts')).toBeNull()
})

test('Edit hands your message to the composer state', () => {
  renderMessage(mine)
  fireEvent.click(act('Edit message from You'))
  expect(screen.getByTestId('editing').textContent).toBe('mine-1')
})

test('Pin calls the place’s toggle and shows the pressed state', () => {
  const { onTogglePin } = renderMessage(mine, { pinned: true })
  const pin = act('Unpin message from You')
  expect(pin.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(pin)
  expect(onTogglePin).toHaveBeenCalledOnce()
})

test('Retry posts to the message’s retry endpoint', async () => {
  const { fetchMock } = renderMessage(reply, { canRetry: true })
  fireEvent.click(act('Retry reply from builder'))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/rooms/room-1/messages/reply-1/retry' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
})

test('Delete on your message asks for the rewind', () => {
  renderMessage(mine)
  fireEvent.click(act('Delete message from You'))
  expect(screen.getByRole('dialog', { name: 'Delete this message?' })).toBeDefined()
})

test('an agent message that does not answer the person has no Retry', () => {
  renderMessage(reply)
  expect(names()).not.toContain('Retry reply from builder')
  expect(names()).toContain('Delete message from builder')
})

test('a 409 on Retry is worded neutrally', async () => {
  const fetchMock = mockFetch(() =>
    jsonResponse({ code: 'conflict', message: 'Resume the work first.' }, 409),
  )
  vi.stubGlobal('fetch', fetchMock)
  renderInRoom(
    <BoldMessage
      message={reply}
      agents={agents}
      versions={[]}
      onView={() => undefined}
      pinned={false}
      pinBusy={false}
      onTogglePin={() => undefined}
      canRetry
    />,
  )
  fireEvent.click(act('Retry reply from builder'))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This reply can’t be retried right now.',
  )
})

test('Edit runs the place’s onEdit hook after loading the composer', () => {
  const onEdit = vi.fn()
  renderMessage(mine, { onEdit })
  fireEvent.click(act('Edit message from You'))
  expect(onEdit).toHaveBeenCalledOnce()
  expect(screen.getByTestId('editing').textContent).toBe('mine-1')
})

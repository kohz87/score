import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message, MessagePart } from '@score/contract'
import { MessageItem } from './MessageItem.tsx'
import { reduceMessages } from './queries.ts'

const summary = (extra: Partial<Extract<MessagePart, { kind: 'summary' }>> = {}): Message => ({
  id: 'sum-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [
    { kind: 'summary', coversUntil: 'm9', text: 'We chose **plan B**. <b>raw</b>', ...extra },
  ],
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming: false,
  refs: [],
})
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"ok":true}'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const methods = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)

test('shows the summary with its author, as Markdown without HTML, and without the message actions', () => {
  render(<MessageItem message={summary()} agents={[]} />)
  expect(screen.getByText(/written by lead/)).toBeTruthy()
  expect(screen.getByText('plan B').tagName).toBe('STRONG')
  expect(document.querySelector('b')).toBeNull()
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
})

test('a stale summary says it is not used as context', () => {
  render(<MessageItem message={summary({ stale: true })} agents={[]} />)
  expect(screen.getByText(/not used as context/)).toBeTruthy()
})

test('the person can edit, regenerate and delete it', async () => {
  render(<MessageItem message={summary()} agents={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByLabelText('Summary text'), { target: { value: 'My version' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(methods()).toContain('PATCH /api/rooms/general/summary'))
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ text: 'My version' })
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
  await waitFor(() => expect(methods()).toContain('POST /api/rooms/general/summary'))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete summary' }))
  await waitFor(() => expect(methods()).toContain('DELETE /api/rooms/general/summary'))
})

test('message.updated with parts replaces the cached parts (stale marking)', () => {
  const message = summary()
  const data = { items: [message], nextCursor: null, typing: {} }
  const next = reduceMessages(
    data,
    {
      type: 'message.updated',
      seq: 3,
      ts: message.createdAt,
      data: {
        roomId: 'general',
        messageId: 'sum-1',
        parts: [{ kind: 'summary', coversUntil: 'm9', text: 'x', stale: true }],
      },
    },
    'general',
    true,
  )
  expect(next.items[0]!.parts[0]).toMatchObject({ stale: true })
  expect(next.items[0]!.editedBy).toBeUndefined()
})

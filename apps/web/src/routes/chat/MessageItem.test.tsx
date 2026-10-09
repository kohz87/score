import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message, MessagePart } from '@score/contract'
import { MessageItem } from './MessageItem.tsx'

const tool = (name: string, status: 'running' | 'ok' | 'error' = 'ok'): MessagePart => ({
  kind: 'tool',
  tool: name,
  args: `${name} --flag`,
  result: `${name} result`,
  status,
})
const make = (parts: MessagePart[], streaming = false): Message => ({
  id: 'reply-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts,
  createdAt: '2026-10-09T10:00:00.000Z',
  streaming,
  // Fresh, so these tests are about something other than the stalled-reply notice (MessageItem.stall.test.tsx).
  progressAt: new Date().toISOString(),
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

test('text parts render as Markdown', () => {
  render(
    <MessageItem message={make([{ kind: 'text', text: '**bold** and `code`' }])} agents={[]} />,
  )
  expect(screen.getByText('bold').tagName).toBe('STRONG')
})

test('a tool part is a collapsed card that opens to its arguments and result', () => {
  render(<MessageItem message={make([tool('terminal')])} agents={[]} />)
  const summary = screen.getByText('terminal').closest('summary')!
  const details = summary.closest('details')!
  expect(details.open).toBe(false)
  expect(screen.getByText('Done')).toBeTruthy()
  fireEvent.click(summary)
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(screen.getByLabelText('Result').textContent).toBe('terminal result')
})

test('a failed tool says so, and a running one only counts as running while the reply streams', () => {
  const { rerender } = render(
    <MessageItem message={make([tool('a', 'error'), tool('b', 'running')], true)} agents={[]} />,
  )
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByText('Running')).toBeTruthy()
  rerender(<MessageItem message={make([tool('a', 'error'), tool('b', 'running')])} agents={[]} />)
  expect(screen.queryByText('Running')).toBeNull()
})

test('thinking is collapsed and labelled by the reply state', () => {
  const parts: MessagePart[] = [{ kind: 'thinking', text: 'first the tests' }]
  const { rerender } = render(<MessageItem message={make(parts, true)} agents={[]} />)
  expect(screen.getByText('Thinking…').closest('details')!.open).toBe(false)
  rerender(<MessageItem message={make(parts)} agents={[]} />)
  expect(screen.getByText('Thought process')).toBeTruthy()
})

test('Expand all appears with three tool cards and opens then closes them all', () => {
  render(<MessageItem message={make([tool('a'), tool('b')])} agents={[]} />)
  expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull()
  cleanup()
  render(<MessageItem message={make([tool('a'), tool('b'), tool('c')])} agents={[]} />)
  const open = () => [...document.querySelectorAll('details')].map((item) => item.open)
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  expect(open()).toEqual([true, true, true])
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
  expect(open()).toEqual([false, false, false])
})

test('a streaming reply has a Stop button that posts to the stop route', async () => {
  render(<MessageItem message={make([{ kind: 'text', text: 'working' }], true)} agents={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop reply from builder' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/rooms/general/messages/reply-1/stop')
  cleanup()
  render(<MessageItem message={make([{ kind: 'text', text: 'done' }])} agents={[]} />)
  expect(screen.queryByRole('button', { name: /^Stop reply/ })).toBeNull()
})

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Message, MessagePart } from '@score/contract'
import { MemoryRouter } from 'react-router'
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

test('a sub-agent card nests the sub-agent’s calls, collapsed, with a one-line summary', () => {
  const agentCard: MessagePart = {
    kind: 'tool',
    tool: 'Agent',
    args: 'List all files',
    result: null,
    status: 'ok',
    callId: 'c1',
    subagent: {
      status: 'done',
      description: 'List files in folder',
      subagentType: 'general-purpose',
      toolCalls: 1,
      durationMs: 7550,
      totalTokens: 19455,
    },
  }
  const inner: MessagePart = {
    ...(tool('Bash') as object),
    callId: 'c2',
    parentCallId: 'c1',
  } as MessagePart
  const orphan: MessagePart = {
    ...(tool('Read') as object),
    callId: 'c3',
    parentCallId: 'gone',
  } as MessagePart
  render(<MessageItem message={make([agentCard, inner, orphan])} agents={[]} />)
  const line = screen.getByText('Sub-agent · List files in folder · 1 tool call · done')
  const details = line.closest('details')!
  expect(details.open).toBe(false)
  expect(screen.getByText('sub-agent')).toBeTruthy()
  // The nested call lives inside the Agent card; the orphan stays beside it.
  expect(details.textContent).toContain('Bash')
  expect(screen.getByText('Read').closest('details')).not.toBe(details)
  expect(details.contains(screen.getByText('Read'))).toBe(false)
  expect(screen.getAllByText('Bash')).toHaveLength(1)
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
  // The status line says it as well, under the reply.
  expect(screen.getAllByText('Thinking…')).toHaveLength(2)
  expect(screen.getByText('Thinking…', { selector: 'summary' }).closest('details')!.open).toBe(
    false,
  )
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

test('a reply being written says what the agent is doing right now, and nothing once it is finished', () => {
  const { rerender } = render(
    <MessageItem message={make([tool('search_changelog', 'running')], true)} agents={[]} />,
  )
  const status = screen.getByText(
    (_, element) => element?.tagName === 'P' && element.className.includes('live-status'),
  )
  expect(status.textContent).toBe('Calling search_changelog()…')
  expect(status.querySelector('code')?.textContent).toBe('search_changelog()')
  rerender(
    <MessageItem
      message={make([tool('search_changelog'), { kind: 'text', text: 'Found two entries' }], true)}
      agents={[]}
    />,
  )
  expect(screen.getByText('Writing the reply…')).toBeTruthy()
  rerender(
    <MessageItem message={make([{ kind: 'text', text: 'Found two entries' }])} agents={[]} />,
  )
  expect(screen.queryByText('Writing the reply…')).toBeNull()
})

test('workspace links follow the caller’s linkFor (the bold room’s Workbench) and stay classic without it', () => {
  const agents = [
    {
      id: 'builder',
      name: 'builder',
      style: { color: '#19C39A', shape: 'triangle' },
    } as unknown as Parameters<typeof MessageItem>[0]['agents'][number],
  ]
  const message = make([{ kind: 'text', text: 'See [the feed](workspace://api/events.py).' }])
  const { unmount } = render(
    <MemoryRouter>
      <MessageItem
        message={message}
        agents={agents}
        workspaceLinkFor={(target) => `/b?job=j1&work=code&file=${target.path}`}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'the feed' }).getAttribute('href')).toBe(
    '/b?job=j1&work=code&file=api/events.py',
  )
  unmount()
  render(
    <MemoryRouter>
      <MessageItem message={message} agents={agents} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'the feed' }).getAttribute('href')).not.toContain('/b?')
})

test('3.10.0: a finished agent reply shows its speed figures quietly', () => {
  const message: Message = {
    ...make([{ kind: 'text', text: 'Done.' }]),
    speed: { ttftMs: 1234, tokensPerSecond: 48.4, outputTokens: 1240 },
  }
  render(<MessageItem message={message} agents={[]} />)
  expect(screen.getByText('first token 1.2 s · 48 tok/s avg · 1,240 tokens')).toBeTruthy()
})

test('3.10.0: unmeasured figures are left out, and a streaming reply shows none', () => {
  const partial: Message = {
    ...make([{ kind: 'text', text: 'Done.' }]),
    speed: { ttftMs: 640, tokensPerSecond: null, outputTokens: null },
  }
  const { unmount } = render(<MessageItem message={partial} agents={[]} />)
  expect(screen.getByText('first token 640 ms')).toBeTruthy()
  unmount()
  const streaming: Message = {
    ...make([{ kind: 'text', text: 'Writing' }], true),
    speed: { ttftMs: 640, tokensPerSecond: 10, outputTokens: 5 },
  }
  render(<MessageItem message={streaming} agents={[]} />)
  expect(screen.queryByText(/first token/)).toBeNull()
})

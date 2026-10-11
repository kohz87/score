import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Approval, Message } from '@score/contract'
import { MessageItem } from './MessageItem.tsx'

let approvals: Approval[] = []
vi.mock('../../data/query-client.ts', async () => {
  const { createContext } = await import('react')
  return {
    useStreamQuery: () => ({ data: approvals, status: 'ready' }),
    StreamContext: createContext(null),
  }
})

const START = Date.parse('2026-10-09T10:00:00.000Z')
const reply = (over: Partial<Message> = {}): Message => ({
  id: 'reply-1',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts: [],
  createdAt: new Date(START).toISOString(),
  streaming: true,
  refs: [{ kind: 'run', runId: 'run-1' }],
  ...over,
})
const NOTICE = /Waiting for the model/

beforeEach(() => {
  vi.useFakeTimers({ now: START })
  approvals = []
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('a streaming reply with no progress for 60 s says it is waiting, and updates every 30 s', () => {
  render(<MessageItem message={reply()} agents={[]} />)
  act(() => void vi.advanceTimersByTime(55_000))
  expect(screen.queryByText(NOTICE)).toBeNull()
  act(() => void vi.advanceTimersByTime(5_000))
  expect(screen.getByText(NOTICE).textContent).toContain('(1 min)')
  expect(screen.getByText(NOTICE).textContent).toContain('rate limit or a provider error')
  expect(screen.getByRole('button', { name: /Stop reply/ })).toBeTruthy()
  act(() => void vi.advanceTimersByTime(30_000))
  expect(screen.getByText(NOTICE).textContent).toContain('(1 min 30 s)')
})

test('progress removes the notice and restarts the clock', () => {
  const { rerender } = render(<MessageItem message={reply()} agents={[]} />)
  act(() => void vi.advanceTimersByTime(90_000))
  expect(screen.getByText(NOTICE)).toBeTruthy()
  rerender(
    <MessageItem message={reply({ progressAt: new Date(Date.now()).toISOString() })} agents={[]} />,
  )
  expect(screen.queryByText(NOTICE)).toBeNull()
  act(() => void vi.advanceTimersByTime(61_000))
  expect(screen.getByText(NOTICE)).toBeTruthy()
})

test('a reply waiting for your approval is not called stalled', () => {
  approvals = [
    { status: 'pending', refs: [{ kind: 'run', runId: 'run-1' }] } as unknown as Approval,
  ]
  render(<MessageItem message={reply()} agents={[]} />)
  act(() => void vi.advanceTimersByTime(120_000))
  expect(screen.queryByText(NOTICE)).toBeNull()
})

test('a finished reply never shows the notice', () => {
  render(<MessageItem message={reply({ streaming: false })} agents={[]} />)
  act(() => void vi.advanceTimersByTime(120_000))
  expect(screen.queryByText(NOTICE)).toBeNull()
})

test('Hermes’s “not processed” text becomes a plain failure line and keeps Retry', () => {
  render(
    <MessageItem
      message={reply({
        streaming: false,
        parts: [
          { kind: 'text', text: 'Your request was not processed because the provider failed.' },
        ],
      })}
      agents={[]}
    />,
  )
  expect(screen.getByText(/The model didn’t answer/)).toBeTruthy()
  expect(screen.queryByText(/not processed/)).toBeNull()
  expect(screen.getByRole('button', { name: /Retry reply/ })).toBeTruthy()
})

import { cleanup, render, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { StreamEvent } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { StreamContext } from '../data/query-client.ts'
import { NotificationBridge } from './NotificationBridge.tsx'

const shown: { title: string; body: string }[] = []
class FakeNotification {
  static permission = 'granted'
  onclick: (() => void) | null = null
  constructor(
    readonly title: string,
    options: { body: string },
  ) {
    shown.push({ title, body: options.body })
  }
  close() {}
}

let listener: ((event: StreamEvent) => void) | undefined
const context = {
  client: {
    subscribe: (next: (event: StreamEvent) => void) => (
      (listener = next),
      () => (listener = undefined)
    ),
  },
  queries: { register: () => ({ getSnapshot: () => ({ data: [{ id: 'lead', name: 'Lead' }] }) }) },
} as never

beforeEach(() => {
  shown.length = 0
  localStorage.setItem('score.notifications', JSON.stringify({ enabled: true }))
  vi.stubGlobal('Notification', FakeNotification)
  Object.assign(window, { Notification: FakeNotification })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

test('a stream event becomes a notification with the agent name', async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <StreamContext value={context}>
        <NotificationBridge />
      </StreamContext>
    </MemoryRouter>,
  )
  const event = {
    type: 'approval.requested',
    seq: 1,
    data: { id: 'a1', agentId: 'lead', title: 'x', actionable: true, status: 'pending' },
  } as unknown as StreamEvent
  await act(async () => listener!(event))
  await vi.waitFor(() =>
    expect(shown).toEqual([
      { title: 'Approval needed', body: 'Lead is waiting for your decision.' },
    ]),
  )
})

test('without a stream the bridge does nothing', () => {
  expect(() =>
    render(
      <MemoryRouter>
        <NotificationBridge />
      </MemoryRouter>,
    ),
  ).not.toThrow()
})

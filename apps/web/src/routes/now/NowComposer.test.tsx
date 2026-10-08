import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { NowComposer } from './NowCards.tsx'

class Source extends EventTarget {
  close() {}
}
const agent: AgentSummary = {
  id: 'lead',
  name: 'lead',
  role: 'Lead',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const room = (id: string, kind: 'room' | 'direct') => ({
  id,
  name: id,
  kind,
  leadAgentId: 'lead',
  members: ['lead'],
  unread: 0,
  activeAgents: [],
  channels: [],
})
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
const cleanups: (() => void)[] = []

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/rooms')
        return json({
          asOfSeq: 1,
          rooms: [room('room-a', 'room'), room('room-b', 'room')],
          directs: [room('dm-lead', 'direct')],
        })
      if (url === '/api/commands') return json({ items: [] })
      return json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function mount(roomId: string | null) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  cleanups.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const view = (id: string | null) => (
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <MemoryRouter>
          <NowComposer roomId={id} agents={[agent]} />
        </MemoryRouter>
      </StreamContext>
    </QueryClientProvider>
  )
  const result = render(view(roomId))
  return (id: string | null) => result.rerender(view(id))
}

test('a direct conversation can be composed into from Now', async () => {
  mount('dm-lead')
  expect(await screen.findByRole('combobox', { name: 'Message dm-lead' })).toBeTruthy()
  expect(screen.queryByText(/Create a room/)).toBeNull()
})

test('with no thread yet Now falls back to the first conversation, direct ones included', async () => {
  const { rerender } = { rerender: mount(null) }
  void rerender
  expect(await screen.findByRole('combobox', { name: 'Message room-a' })).toBeTruthy()
})

test('when the latest thread changes, the typed text stays with its room instead of moving to the new one', async () => {
  const setRoom = mount('room-a')
  const first = (await screen.findByRole('combobox', {
    name: 'Message room-a',
  })) as HTMLTextAreaElement
  fireEvent.change(first, { target: { value: 'for A', selectionStart: 5 } })
  setRoom('room-b')
  const second = (await screen.findByRole('combobox', {
    name: 'Message room-b',
  })) as HTMLTextAreaElement
  expect(second.value).toBe('')
  setRoom('room-a')
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Message room-a' }) as HTMLTextAreaElement).value,
    ).toBe('for A'),
  )
})

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import type { AgentSummary, Message, Room } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { ImportedBanner } from './ImportedBanner.tsx'
import { MessageItem } from './MessageItem.tsx'
import { OutsideSessions } from './OutsideSessions.tsx'

const agent: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Lead',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const session = (patch: object = {}) => ({
  id: 's1',
  agentId: 'lead',
  source: 'telegram',
  sourceLabel: 'Telegram',
  title: 'Plan the launch',
  startedAt: '2026-10-08T10:00:00.000Z',
  messageCount: 4,
  busy: false,
  roomId: null,
  ...patch,
})
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let sessions: object[]
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })

beforeEach(() => {
  sessions = [session(), session({ id: 's2', source: 'cli', sourceLabel: 'CLI', title: '' })]
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input)
    if (url === '/api/outside-sessions/import' && init?.method === 'POST')
      return json({ roomId: 'room-new', imported: 4 })
    if (url === '/api/rooms/r1/continue-session') {
      if (continueResult === 'busy')
        return json(
          { error: { code: 'session_busy', message: 'This session is still active on Telegram.' } },
          409,
        )
      return json({ mode: continueResult })
    }
    return json({ items: sessions, unavailable: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})
let continueResult: 'same_session' | 'new_session' | 'busy' = 'same_session'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  continueResult = 'same_session'
})

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}
const wrap = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        {node}
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )

test('From elsewhere lists sessions grouped by source and imports one into a room', async () => {
  wrap(<OutsideSessions agents={[agent]} />)
  fireEvent.click(screen.getByRole('button', { name: /^Show/ }))
  const telegram = await screen.findByRole('region', { name: 'Telegram' })
  expect(within(telegram).getByText('Plan the launch')).toBeDefined()
  expect(within(telegram).getByText(/Lead · .* · 4 messages/)).toBeDefined()
  const cli = screen.getByRole('region', { name: 'CLI' })
  expect(within(cli).getByText('Untitled session')).toBeDefined()
  fireEvent.click(within(telegram).getByRole('button', { name: /Import Plan the launch/ }))
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/chat/room-new'))
  const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/outside-sessions/import')!
  expect(JSON.parse(String(call[1]!.body))).toEqual({ agentId: 'lead', sessionId: 's1' })
})

test('an already imported session links to its room; busy sessions say so', async () => {
  sessions = [session({ roomId: 'r9', busy: true })]
  wrap(<OutsideSessions agents={[agent]} />)
  fireEvent.click(screen.getByRole('button', { name: /^Show/ }))
  const link = await screen.findByRole('link', { name: /Open the imported room/ })
  expect(link.getAttribute('href')).toBe('/chat/r9')
  expect(screen.getByText(/active now/)).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull()
})

const imported = (continued: 'same_session' | 'new_session' | null): Room => ({
  id: 'r1',
  name: '#telegram-plan #imported',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead'],
  unread: 0,
  activeAgents: [],
  channels: [],
  importedFrom: {
    agentId: 'lead',
    sessionId: 's1',
    source: 'telegram',
    label: 'Telegram',
    continued,
  },
})

test('Continue here says which happened: same Hermes session', async () => {
  wrap(<ImportedBanner room={imported(null)} agents={[agent]} />)
  expect(screen.getByText(/Imported from Telegram/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Continue here' }))
  expect((await screen.findByRole('status')).textContent).toContain('same Hermes session')
  expect(screen.queryByRole('button', { name: 'Continue here' })).toBeNull()
})

test('Continue here says which happened: a new session with a summary', async () => {
  continueResult = 'new_session'
  wrap(<ImportedBanner room={imported(null)} agents={[agent]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue here' }))
  expect((await screen.findByRole('status')).textContent).toContain('short summary')
})

test('Continue here shows the refusal while the session is busy; an already continued room shows its state', async () => {
  continueResult = 'busy'
  wrap(<ImportedBanner room={imported(null)} agents={[agent]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue here' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'This session is still active on Telegram.',
  )
  expect(screen.getByRole('button', { name: 'Continue here' })).toBeDefined()
  cleanup()
  wrap(<ImportedBanner room={imported('new_session')} agents={[agent]} />)
  expect(screen.getByRole('status').textContent).toContain('short summary')
})

test('imported messages are marked and cannot be edited or retried', () => {
  const copy = (id: string, kind: 'you' | 'agent'): Message => ({
    id,
    roomId: 'r1',
    author: kind === 'you' ? { kind } : { kind, agentId: 'lead' },
    to: [],
    parts: [{ kind: 'text', text: 'Old words' }],
    createdAt: '2026-10-08T10:00:00.000Z',
    streaming: false,
    refs: [],
  })
  const { rerender } = render(
    <QueryClientProvider client={createQueryClient()}>
      <MessageItem message={copy('import:r1:0', 'you')} agents={[agent]} importedLabel="Telegram" />
    </QueryClientProvider>,
  )
  expect(screen.getByText('from Telegram')).toBeDefined()
  expect(screen.queryByRole('button', { name: /^Edit message/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^Delete message/ })).toBeDefined()
  rerender(
    <QueryClientProvider client={createQueryClient()}>
      <MessageItem
        message={copy('import:r1:1', 'agent')}
        agents={[agent]}
        importedLabel="Telegram"
      />
    </QueryClientProvider>,
  )
  expect(screen.queryByRole('button', { name: /^Retry reply/ })).toBeNull()
  // An ordinary message of the same shape keeps its actions.
  rerender(
    <QueryClientProvider client={createQueryClient()}>
      <MessageItem message={copy('plain', 'agent')} agents={[agent]} />
    </QueryClientProvider>,
  )
  expect(screen.getByRole('button', { name: /^Retry reply/ })).toBeDefined()
  expect(screen.queryByText('from Telegram')).toBeNull()
})

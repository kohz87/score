import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { Composer } from './Composer.tsx'

const agents: AgentSummary[] = [
  {
    id: 'lead',
    name: 'Lead',
    role: 'Example',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  },
]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

function mount(orchestrate?: (goal: string) => void) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Composer
          roomId="general"
          roomName="general"
          agents={agents}
          {...(orchestrate ? { orchestrate } : {})}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const box = () => screen.getByRole('combobox', { name: 'Message general' }) as HTMLTextAreaElement
const type = (value: string) =>
  fireEvent.change(box(), { target: { value, selectionStart: value.length } })

beforeEach(() => {
  localStorage.clear()
  fetchMock = vi.fn(async (input) =>
    String(input) === '/api/commands'
      ? new Response(JSON.stringify({ items: [] }))
      : new Response('{}'),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')

test('/orchestrate <goal> hands the goal over and sends nothing', async () => {
  const orchestrate = vi.fn()
  mount(orchestrate)
  type('/orchestrate Write the release notes')
  fireEvent.keyDown(box(), { key: 'Enter' })
  await waitFor(() => expect(orchestrate).toHaveBeenCalledWith('Write the release notes'))
  expect(box().value).toBe('')
  expect(posted()).toHaveLength(0)
})

test('the + menu offers Start an orchestration, with an empty goal', () => {
  const orchestrate = vi.fn()
  mount(orchestrate)
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start an orchestration…' }))
  expect(orchestrate).toHaveBeenCalledWith('')
})

test('/orchestrate shows in the slash menu only where orchestrations can start', async () => {
  mount(vi.fn())
  type('/orch')
  expect(await screen.findByRole('option', { name: /orchestrate/ })).toBeDefined()
  cleanup()
  mount()
  type('/orch')
  expect(screen.queryByRole('option', { name: /orchestrate/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Attach files' })).toBeDefined()
})

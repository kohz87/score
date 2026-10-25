import type { AgentOperation, AgentSummary } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BoldAgentStatus } from './BoldAgentOperation.tsx'
import { BoldRemoveAgent } from './BoldRemoveAgent.tsx'

const opId = '11111111-1111-4111-8111-111111111111'
const incarnationId = '22222222-2222-4222-8222-222222222222'
type Lifecycle = NonNullable<AgentSummary['lifecycle']>
const lifecycle = (state: Lifecycle['state']): Lifecycle => ({
  state,
  incarnationId,
  operationId: opId,
})

function operation(patch: Partial<AgentOperation>): AgentOperation {
  return {
    id: opId,
    kind: 'create',
    targetName: 'g3',
    incarnationId,
    requestHash: 'h',
    state: 'needs_attention',
    steps: [
      { name: 'create_profile', state: 'completed' },
      { name: 'model', state: 'pending' },
    ],
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    nextStep: 'model',
    error: 'Model refused',
    exportPath: null,
    retryable: true,
    ...patch,
  }
}

let current: AgentOperation
let calls: { path: string; method: string }[]
let blockers: string[]

beforeEach(() => {
  calls = []
  blockers = ['An operation already holds this agent.']
  current = operation({})
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      calls.push({ path: url.pathname, method })
      if (url.pathname === `/api/agents/operations/${opId}/retry`) {
        current = operation({ state: 'completed', nextStep: null, error: null, retryable: false })
        blockers = []
        return Response.json(current)
      }
      if (url.pathname === `/api/agents/operations/${opId}`) return Response.json(current)
      if (url.pathname === '/api/agents/preview')
        return Response.json({
          kind: 'delete',
          targetName: 'g3',
          hash: 'hash',
          inherited: {
            memories: [],
            skills: [],
            plugins: [],
            approvalSettings: [],
            credentialsPresent: [],
          },
          effects: [],
          blockers,
          pendingWork: {
            activeRuns: 0,
            queuedTurns: 0,
            pendingApprovals: 0,
            assignments: 0,
            disposition: 'Nothing is running.',
          },
          exportPath: '/tmp/g3.tar',
        })
      return Response.json({}, { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/b/team/g3']}>
        <Routes>
          <Route path="/b/team/g3" element={children} />
          <Route path="/b/team" element={<p>Team list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('a stopped setup says where it stopped and Retry posts to the operation', async () => {
  wrap(<BoldAgentStatus name="g3" lifecycle={lifecycle('needs_attention')} />)
  const card = await screen.findByLabelText('g3 status')
  expect(card.getAttribute('data-protected')).toBe('block')
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('Setting up g3 stopped at Set model.'),
  )
  expect(screen.getByRole('alert').textContent).toBe('Model refused')
  fireEvent.click(screen.getByRole('button', { name: 'Retry: Set model' }))
  await waitFor(() =>
    expect(calls).toContainEqual({
      path: `/api/agents/operations/${opId}/retry`,
      method: 'POST',
    }),
  )
  // Completed: the card goes away.
  await waitFor(() => expect(screen.queryByLabelText('g3 status')).toBeNull())
})

test('a running setup and a running removal say so in plain words', async () => {
  current = operation({ state: 'running', error: null, retryable: false })
  const { unmount } = wrap(<BoldAgentStatus name="g3" lifecycle={lifecycle('setting_up')} />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Setting up g3…'))
  unmount()
  current = operation({ kind: 'delete', state: 'running', error: null, retryable: false })
  wrap(<BoldAgentStatus name="g3" lifecycle={lifecycle('deleting')} />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Removing g3…'))
})

test('a finished removal leaves for the Team list', async () => {
  current = operation({ kind: 'delete', state: 'completed', error: null, nextStep: null })
  wrap(<BoldAgentStatus name="g3" lifecycle={lifecycle('deleting')} />)
  expect(await screen.findByText('Team list')).toBeTruthy()
})

test('Remove is not a dead button: the stopped step is retried inline and the preview runs again', async () => {
  wrap(
    <BoldRemoveAgent
      agentId="g3"
      name="g3"
      coding={false}
      lifecycle={lifecycle('needs_attention')}
      onClose={() => {}}
    />,
  )
  expect(await screen.findByText('Finish or retry the stopped step first:')).toBeTruthy()
  expect(screen.queryByText('An operation already holds this agent.')).toBeNull()
  expect(screen.queryByLabelText(/Type g3 to confirm/u)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry: Set model' }))
  // After the retry the preview is asked again and the typed-name field comes back.
  expect(await screen.findByLabelText(/Type g3 to confirm/u)).toBeTruthy()
  expect(calls.filter((call) => call.path === '/api/agents/preview')).toHaveLength(2)
  expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true)
})

test('other blockers stay next to the stuck step, whatever the server words the hold as', async () => {
  blockers = ['Something else keeps g3 busy.', 'Not the same wording at all.']
  wrap(
    <BoldRemoveAgent
      agentId="g3"
      name="g3"
      coding={false}
      lifecycle={lifecycle('needs_attention')}
      onClose={() => {}}
    />,
  )
  expect(await screen.findByText('Finish or retry the stopped step first:')).toBeTruthy()
  expect(screen.getByText('Something else keeps g3 busy.')).toBeTruthy()
  expect(screen.getByText('Not the same wording at all.')).toBeTruthy()
  expect(screen.getByText(/0 active runs/u)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
})

test('if the stopped step cannot be read, the server blockers show and Remove stays off', async () => {
  const real = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/operations/')
        ? Promise.resolve(Response.json({}, { status: 500 }))
        : real(input, init),
    ),
  )
  wrap(
    <BoldRemoveAgent
      agentId="g3"
      name="g3"
      coding={false}
      lifecycle={lifecycle('needs_attention')}
      onClose={() => {}}
    />,
  )
  expect(await screen.findByText('An operation already holds this agent.')).toBeTruthy()
  const remove = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  expect(screen.queryByText('Finish or retry the stopped step first:')).toBeNull()
})

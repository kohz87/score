import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, AgentOperation, AgentPreview } from '@score/contract'
import { AddAgent } from './AddAgent.tsx'
import { ProfileSettings } from './ProfileSettings.tsx'

const agent: AgentDetail = {
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  model: { id: 'fake-model', label: 'Demo', via: 'Demo', fallback: null },
  status: 'idle',
  activity: null,
  served: true,
  tagline: '',
  personality: { excerpt: '', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: null,
  skills: [],
  memory: [],
  tools: [],
  helpersMax: null,
  routines: [],
  channels: [],
  permissions: [],
}
const preview: AgentPreview = {
  kind: 'create',
  targetName: 'helper',
  hash: 'a'.repeat(64),
  inherited: {
    memories: ['MEMORY.md'],
    skills: ['collaboration'],
    plugins: ['score-bridge'],
    approvalSettings: ['mode: smart'],
    credentialsPresent: ['example-provider'],
  },
  effects: ['Copy configuration, memories and plugins.'],
  blockers: [],
  pendingWork: {
    activeRuns: 0,
    queuedTurns: 0,
    pendingApprovals: 0,
    assignments: 0,
    disposition: 'Remove memberships; keep history.',
  },
  exportPath: null,
}
const operation: AgentOperation = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'create',
  targetName: 'helper',
  incarnationId: '20000000-0000-4000-8000-000000000001',
  requestHash: preview.hash,
  state: 'running',
  steps: [{ name: 'create_profile', state: 'running' }],
  createdAt: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-08T00:00:00.000Z',
  nextStep: 'create_profile',
  error: null,
  exportPath: null,
}
let calls: { path: string; body: Record<string, unknown>; init: RequestInit }[]
let response: (path: string, init: RequestInit) => unknown
beforeEach(() => {
  calls = []
  response = (path) =>
    path.endsWith('/preview') ? preview : path.includes('/operations/') ? operation : operation
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : {}, init })
    return new Response(JSON.stringify(response(path, init)), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}
async function form(clone = false) {
  mount(<AddAgent agents={[agent]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'helper' } })
  fireEvent.change(screen.getByLabelText('Role / description'), {
    target: { value: 'Helps build changes' },
  })
  if (clone) fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'builder' } })
  else fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }))
  await screen.findByRole('heading', { name: 'Review changes' })
}
test('create shows a glyph, previews first, and follows durable progress', async () => {
  await form()
  expect(screen.getByRole('img', { name: 'helper, triangle' })).toBeTruthy()
  expect(calls.filter((call) => call.path === '/api/agents')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
  await screen.findByRole('heading', { name: 'Setting up' })
  expect(calls.find((call) => call.path === '/api/agents')?.body).toMatchObject({
    id: 'helper',
    previewHash: preview.hash,
    style: agent.style,
  })
  expect(calls.find((call) => call.path === '/api/agents')?.init.headers).toBeInstanceOf(Headers)
})
test('clone lists capabilities and credential names and needs its checkbox', async () => {
  await form(true)
  expect(screen.getByText('example-provider')).toBeTruthy()
  expect(screen.getByText('MEMORY.md')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  fireEvent.change(screen.getByLabelText('Role / description'), {
    target: { value: 'Changed description' },
  })
  expect(screen.queryByRole('heading', { name: 'Review changes' })).toBeNull()
  expect(
    (screen.getByRole('button', { name: 'Preview changes' }) as HTMLButtonElement).disabled,
  ).toBe(false)
})
test('an incomplete inheritance inventory blocks creation and the dialog returns focus', async () => {
  response = () => ({ ...preview, blockers: ['Credential inventory unavailable'] })
  await form(true)
  expect(screen.getByRole('alert').textContent).toContain('Credential inventory unavailable')
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  expect((screen.getByRole('button', { name: 'Create agent' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add agent' }))
})
test('danger zone displays pending work and export warning and requires the exact canonical name', async () => {
  response = (path) =>
    path.endsWith('/preview')
      ? {
          ...preview,
          kind: 'delete',
          targetName: 'builder',
          exportPath: '/private/profile-backups/builder.tar.gz',
        }
      : { ...operation, kind: 'delete', targetName: 'builder' }
  mount(<ProfileSettings agent={agent} />)
  expect(screen.getByText(/omits credentials and is not a full undo/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
  await screen.findByRole('heading', { name: 'Review deletion' })
  expect(screen.getByText('/private/profile-backups/builder.tar.gz')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Type builder to confirm'), {
    target: { value: 'Builder' },
  })
  expect(
    (screen.getByRole('button', { name: 'Confirm deletion' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  fireEvent.change(screen.getByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
  await waitFor(() =>
    expect(calls.find((call) => call.init.method === 'DELETE')?.body).toEqual({
      typedName: 'builder',
      previewHash: preview.hash,
    }),
  )
})
test('default deletion is disabled and needs-attention has a clear next step', async () => {
  const client = mount(<ProfileSettings agent={{ ...agent, id: 'default' }} />)
  expect((screen.getByRole('button', { name: 'Delete agent' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  cleanup()
  client.clear()
  response = () => ({
    ...operation,
    state: 'needs_attention',
    error: 'Next step: verify_ready. No bridge handshake seen.',
  })
  mount(
    <ProfileSettings
      agent={{
        ...agent,
        lifecycle: {
          state: 'needs_attention',
          incarnationId: operation.incarnationId,
          operationId: operation.id,
        },
      }}
    />,
  )
  expect((await screen.findByRole('alert')).textContent).toContain('Next step: verify_ready')
  expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull()
})

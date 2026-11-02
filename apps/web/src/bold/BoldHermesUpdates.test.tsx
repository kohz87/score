import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BoldHermesUpdates } from './BoldHermesUpdates.tsx'

const agents = [
  {
    id: 'builder',
    name: 'Builder',
    role: 'Builds it',
    style: { color: '#19c39a', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: { id: 'm-2', label: 'Model Two' },
    served: true,
  },
  {
    id: 'coder',
    name: 'Coder',
    role: 'Codes',
    style: { color: '#c3199a', shape: 'circle' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
    runtime: 'claude-code',
  },
]
vi.mock('../data/query-client.ts', () => ({ useStreamQuery: () => ({ data: agents }) }))

const job = {
  id: 'job-1',
  state: 'finished',
  channel: 'main',
  testAgentId: 'builder',
  startedAt: '2026-11-02T09:00:00.000Z',
  endedAt: '2026-11-02T09:05:00.000Z',
  steps: [
    { id: 'wait', state: 'done', note: 'nothing running' },
    { id: 'update', state: 'done', note: null },
    { id: 'check', state: 'done', note: null },
    { id: 'test', state: 'done', note: null },
  ],
  fromVersion: 'v1',
  toVersion: 'v2',
  outcome: 'differs',
  check: {
    hash: 'f'.repeat(64),
    build: { version: '0.22.5', codeSha: 'abc', fingerprint: 'x' },
    parts: [
      { name: 'Hermes version', status: 'same', detail: '0.22.5' },
      { name: 'Session database schema', status: 'changed', detail: 'A new table.' },
    ],
    compatible: false,
    overridable: true,
  },
  test: { agentId: 'builder', ok: true, detail: 'builder answered PONG' },
  backup: 'hermes-backup-1.zip',
  error: null,
  log: ['→ Pulling updates...'],
}

let status: Record<string, unknown>
let calls: { url: string; method: string; body: Record<string, unknown> | undefined }[]

const reply = (body: unknown, code = 200) => Promise.resolve(Response.json(body, { status: code }))

beforeEach(() => {
  localStorage.clear()
  calls = []
  status = {
    available: true,
    version: 'v0.22.5+1099',
    lastCheck: null,
    job: null,
    diskFreeBytes: 12 * 1024 ** 3,
    backupNeedsBytes: 2.9 * 1024 ** 3,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url === '/api/system')
        return reply({
          mode: 'live',
          hermes: {
            version: '0.22.5',
            reachable: true,
            apiServer: true,
            capabilities: [],
            servedProfiles: [],
          },
          bridge: { producers: 1, lastSeenAt: null, isolation: 'unknown' },
          compatibility: { fingerprint: 'f', tested: false, disabled: ['gateway-approvals'] },
          agentIsolation: 'same_user',
          degraded: [],
        })
      if (url === '/api/system/hermes-update') return reply(status)
      if (url === '/api/system/hermes-update/check')
        return reply({
          channel: body?.channel,
          available: true,
          behind: 12,
          summary: 'An update is available: 12 commits behind.',
          restarts: ['gateway [default]'],
          checkedAt: '2026-11-02T09:00:00.000Z',
        })
      if (url === '/api/system/hermes-update/start') {
        if (body?.password === 'wrong')
          return reply({ error: { code: 'wrong_password', message: 'No' } }, 403)
        const running = { ...job, state: 'running', outcome: null, endedAt: null }
        status = { ...status, job: running }
        return reply(running, 202)
      }
      if (url === '/api/settings/hermes/accept') return reply({ ok: true })
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <BoldHermesUpdates />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test('says so when updating Hermes is not available', async () => {
  status = { ...status, available: false, version: null }
  show()
  expect(await screen.findByText('Updating Hermes isn’t available here.')).toBeTruthy()
})

test('checks, then updates with the password and a Hermes agent only', async () => {
  show()
  expect(await screen.findByText('v0.22.5+1099')).toBeTruthy()
  expect(await screen.findByText('Approvals paused')).toBeTruthy()
  const channel = screen.getByLabelText('Update channel') as HTMLSelectElement
  expect(channel.value).toBe('main')
  fireEvent.change(channel, { target: { value: 'stable' } })
  expect(localStorage.getItem('score.hermesUpdateChannel')).toBe('stable')
  fireEvent.click(screen.getByRole('button', { name: 'Check for Hermes updates' }))
  expect(await screen.findByText(/12 commits behind/)).toBeTruthy()
  expect(screen.getByText('Restarts: gateway [default]')).toBeTruthy()
  expect(calls.find((call) => call.url.endsWith('/check'))?.body).toEqual({ channel: 'stable' })
  fireEvent.click(screen.getByRole('button', { name: 'Update Hermes…' }))
  const dialog = screen.getByRole('form', { name: 'Update Hermes' })
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(within(dialog).getByText(/about 2.9 GB; 12.0 GB free/)).toBeTruthy()
  const options = within(dialog)
    .getAllByRole('option')
    .map((option) => option.textContent)
  expect(options).toEqual(['Builder · Model Two', 'No test message (checks only)'])
  fireEvent.change(within(dialog).getByLabelText('Security password'), {
    target: { value: 'wrong' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back up and update' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
  expect((within(dialog).getByLabelText('Security password') as HTMLInputElement).value).toBe('')
  fireEvent.change(within(dialog).getByLabelText('Security password'), {
    target: { value: 'right' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back up and update' }))
  await waitFor(() => expect(screen.getByRole('status', { name: 'Update progress' })).toBeTruthy())
  const start = calls.filter((call) => call.url.endsWith('/start')).at(-1)
  expect(start?.body).toEqual({ channel: 'stable', testAgentId: 'builder', password: 'right' })
  expect(screen.getByText('Test message to Builder')).toBeTruthy()
})

test('a differing result offers the override with the password again', async () => {
  status = { ...status, job }
  show()
  expect(await screen.findByText('Something Score relies on looks different')).toBeTruthy()
  expect(screen.getByText('Session database schema')).toBeTruthy()
  expect(screen.queryByText('Hermes version')).toBeNull()
  fireEvent.change(screen.getByLabelText('Security password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Turn approvals on anyway' }))
  expect(await screen.findByText(/Approvals are on for Hermes v2/)).toBeTruthy()
  expect(calls.find((call) => call.url === '/api/settings/hermes/accept')?.body).toEqual({
    hash: 'f'.repeat(64),
    override: true,
    password: 'pw',
  })
})

test('a broken result names the way back and has no restore button', async () => {
  status = {
    ...status,
    job: {
      ...job,
      outcome: 'broken',
      test: { agentId: 'builder', ok: false, detail: 'no reply' },
    },
  }
  show()
  expect(await screen.findByText('The test message failed')).toBeTruthy()
  expect(screen.getByText('hermes update --channel stable')).toBeTruthy()
  expect(
    screen.getByText('hermes import ~/.hermes/backups/hermes-backup-1.zip --force'),
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
})

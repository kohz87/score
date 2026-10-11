import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AddCodingAgentForm } from './CodingAgent.tsx'

const runtime = (name: string, label: string, extra: object = {}) => ({
  runtime: name,
  label,
  state: 'ready',
  version: '1.0.0',
  testedVersions: ['1.0.0'],
  quota: `${label} quota note.`,
  message: null,
  unverifiedPermissions: [],
  warning: null,
  ...extra,
})
const runtimes = [
  runtime('claude-code', 'Claude Code'),
  runtime('antigravity', 'Antigravity (agy)', {
    unverifiedPermissions: ['full'],
    warning:
      'Antigravity can also browse the web, generate images, schedule work and run sub-agents.',
  }),
]
const usage = {
  runtime: 'antigravity',
  fetchedAt: '2026-10-11T00:00:00.000Z',
  groups: [
    {
      name: 'Gemini Pro',
      fiveHourRemainingPercent: 82,
      fiveHourResets: 'resets in 3h',
      weeklyRemainingPercent: 64,
      weeklyResets: null,
    },
  ],
  text: 'table',
}
let posted: unknown[]
beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return new Response('{"error":{"code":"x","message":"stop here"}}', { status: 400 })
    }
    const body = path.endsWith('/usage') ? usage : { items: runtimes }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('Antigravity: warning, quota, unverified level disabled, no read acknowledgement inside the sandbox, argv-free request', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddCodingAgentForm close={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole('option', { name: 'Antigravity (agy)' }, { timeout: 10_000 })
  fireEvent.change(screen.getByLabelText('Coding CLI'), { target: { value: 'antigravity' } })
  expect(
    await screen.findByText(/browse the web, generate images/, {}, { timeout: 10_000 }),
  ).toBeDefined()
  expect(
    await screen.findByText(/Gemini Pro: 82% left in the 5-hour window/, {}, { timeout: 10_000 }),
  ).toBeDefined()
  const full = screen.getByRole('radio', { name: /Full access/ })
  expect((full as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(/not verified for agy yet/)).toBeDefined()
  fireEvent.change(screen.getByLabelText(/Agent name/), { target: { value: 'agy1' } })
  // Below full access the sandbox keeps Antigravity inside its workspace: the box says so and no acknowledgement is asked.
  expect(screen.getByText(/sandbox keeps it inside its workspace/)).toBeDefined()
  expect(screen.queryByRole('checkbox', { name: /can read any file/ })).toBeNull()
  const submit = screen.getByRole('button', { name: 'Add coding agent' }) as HTMLButtonElement
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() => expect(posted.length).toBe(1))
  expect(posted[0]).toMatchObject({ runtime: 'antigravity', permission: 'workspace-write' })
  expect(posted[0]).not.toHaveProperty('acknowledgeReads')
})

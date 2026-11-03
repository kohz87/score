import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BoldAddAgent } from './BoldAddAgent.tsx'

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
const quota = {
  quota: {
    runtime: 'antigravity',
    seenAt: '2026-10-11T00:00:00.000Z',
    source: 'usage',
    windows: [
      { name: '5 hours', group: 'Gemini Pro', usedPercent: 18, resetsAt: null },
      { name: 'week', group: 'Gemini Pro', usedPercent: 36, resetsAt: null },
    ],
  },
}
let posted: unknown[]
beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return new Response('{"error":{"code":"x","message":"stop here"}}', { status: 400 })
    }
    const body = path.endsWith('/quota') ? quota : { items: runtimes }
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openCodingForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/b/agents?add=agent']}>
        <BoldAddAgent agents={[]} phone={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const from = await screen.findByRole('radiogroup', { name: 'Start from' })
  fireEvent.click(within(from).getByRole('radio', { name: /coding/i }))
  await screen.findByRole('radio', { name: 'Claude Code' }, { timeout: 10_000 })
}

test('coding tool Antigravity: warning, quota, unverified level disabled, no read acknowledgement inside the sandbox, argv-free request', async () => {
  await openCodingForm()
  fireEvent.click(screen.getByRole('radio', { name: 'Antigravity (agy)' }))
  expect(
    await screen.findByText(/browse the web, generate images/, {}, { timeout: 10_000 }),
  ).toBeDefined()
  expect(
    await screen.findByText(
      /Gemini Pro 5 hours 82% left · Gemini Pro week 64% left/,
      {},
      { timeout: 10_000 },
    ),
  ).toBeDefined()
  const full = screen.getByRole('radio', { name: /Full access/ })
  expect((full as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText(/not verified for agy yet/)).toBeDefined()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'agy1' } })
  // Below full access the sandbox keeps Antigravity inside its workspace: the box says so and no acknowledgement is asked.
  expect(screen.getByText(/sandbox keeps it inside its workspace/)).toBeDefined()
  expect(screen.queryByRole('checkbox', { name: /can read any file/ })).toBeNull()
  const submit = screen.getByRole('button', { name: 'Add coding agent' }) as HTMLButtonElement
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() => expect(posted.length).toBe(1))
  expect(posted[0]).toMatchObject({ runtime: 'antigravity', permission: 'workspace-write' })
  expect(posted[0]).not.toHaveProperty('acknowledgeReads')
  expect(posted[0]).not.toHaveProperty('argv')
})

test('coding tool: the optional role is sent only when filled in', async () => {
  await openCodingForm()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'rev' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add coding agent' }))
  await waitFor(() => expect(posted.length).toBe(1))
  expect(posted[0]).not.toHaveProperty('role')
  fireEvent.change(screen.getByLabelText('What does it do?'), { target: { value: 'Reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add coding agent' }))
  await waitFor(() => expect(posted.length).toBe(2))
  expect(posted[1]).toMatchObject({ id: 'rev', role: 'Reviewer' })
})

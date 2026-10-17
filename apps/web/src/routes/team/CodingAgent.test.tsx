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
        <AddCodingAgentForm onAdded={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole('option', { name: 'Antigravity (agy)' }, { timeout: 10_000 })
  fireEvent.change(screen.getByLabelText('Kind of coding agent'), {
    target: { value: 'antigravity' },
  })
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

test('Release: shown only for groups Score can’t attribute, posts once and names nothing internal', async () => {
  const { ReleaseHeld } = await import('./ReleaseHeld.tsx')
  const agent = (canRelease: boolean) => ({
    id: 'coder',
    name: 'Coder',
    role: '',
    runtime: 'claude-code',
    workspace: '/w',
    permission: 'workspace-write',
    model: null,
    style: { color: '#6B4EFF', shape: 'hexagon' },
    quota: 'q',
    quotaFloorPercent: 10,
    cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], confirmed: false },
    heldGroups: [{ runId: 'cr_1', pgid: 4242, canRelease }],
    createdAt: '2026-10-11T00:00:00.000Z',
  })
  let releasable = false
  const releases: string[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      releases.push(path)
      releasable = false
      return new Response(JSON.stringify({ ...agent(false), heldGroups: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ items: [agent(releasable)] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  // A group that is merely still running is not the person's to release.
  await waitFor(() => expect(client.getQueryData(['coding', 'agents'])).toBeDefined())
  expect(screen.queryByRole('button', { name: 'Release agent' })).toBeNull()
  view.unmount()
  releasable = true
  client.clear()
  render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  const button = await screen.findByRole('button', { name: 'Release agent' })
  expect(screen.getByText(/ps -o pid,pgid,args -g 4242/)).toBeTruthy()
  fireEvent.click(button)
  await waitFor(() => expect(releases).toEqual(['/api/coding-agents/coder/release']))
})

test('Release: a supervised run is named by its service, not by a process group', async () => {
  const { ReleaseHeld } = await import('./ReleaseHeld.tsx')
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'coder',
              name: 'Coder',
              role: '',
              runtime: 'claude-code',
              workspace: '/w',
              permission: 'workspace-write',
              model: null,
              style: { color: '#6B4EFF', shape: 'hexagon' },
              quota: 'q',
              quotaFloorPercent: 10,
              cli: {
                state: 'ready',
                version: '1.0.0',
                testedVersions: ['1.0.0'],
                confirmed: false,
              },
              heldGroups: [
                { runId: 'cr_1', pgid: 0, canRelease: true, unit: 'score-01234567-c-abc.service' },
              ],
              createdAt: '2026-10-11T00:00:00.000Z',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ReleaseHeld agentId="coder" />
    </QueryClientProvider>,
  )
  expect(
    await screen.findByText(/systemctl --user status score-01234567-c-abc.service/),
  ).toBeTruthy()
  expect(screen.queryByText(/ps -o pid/)).toBeNull()
})

test('Backend note: says how coding runs launch, lists the host check, and Check again posts', async () => {
  const { CodingBackend } = await import('./CodingBackend.tsx')
  const posts: string[] = []
  let kind: 'unit' | 'process-group' = 'process-group'
  const body = () => ({
    kind,
    note:
      kind === 'unit'
        ? 'Runs as a supervised system service.'
        : 'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them. linger is off',
    checks: [
      {
        name: 'linger',
        ok: kind === 'unit',
        detail: kind === 'unit' ? 'linger enabled' : 'linger is off',
      },
      { name: 'python', ok: true, detail: 'Python at /usr/bin/python3' },
    ],
    checkedAt: '2026-10-12T10:00:00.000Z',
  })
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(path)
      kind = 'unit'
    }
    return new Response(JSON.stringify(body()), { headers: { 'Content-Type': 'application/json' } })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CodingBackend />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(/Runs without a supervisor/)).toBeTruthy()
  expect(screen.getByText(/Host check \(1 not met\)/)).toBeTruthy()
  expect(screen.getByText(/Keeps running after you log out: not met/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(posts).toEqual(['/api/coding-agents/backend/check']))
  expect(await screen.findByText('Runs as a supervised system service.')).toBeTruthy()
  // Only what the design proves: the service's own processes, not work handed to another service or daemon (review #17).
  const promise = screen.getByText(/the service stops this agent and everything running inside it/)
  expect(promise.textContent).toContain(
    'another service, a scheduler or a background daemon isn’t covered',
  )
  expect(promise.textContent).not.toContain('everything it started')
})

test('Backend note: a paused installation says why, offers Check again and makes no supervision promise', async () => {
  const { CodingBackend } = await import('./CodingBackend.tsx')
  const note =
    'Coding runs are paused: this computer no longer meets what supervised services need (linger is off). Fix that and choose Check again.'
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          kind: 'unit',
          note,
          checks: [{ name: 'linger', ok: false, detail: 'linger is off' }],
          checkedAt: '2026-10-12T10:00:00.000Z',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CodingBackend />
    </QueryClientProvider>,
  )
  const paragraph = await screen.findByText(/Coding runs are paused/)
  expect(paragraph.getAttribute('data-backend')).toBe('paused')
  expect(screen.queryByText(/the service stops this agent/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
})

test('the quota floor field: "stop using this agent in runs below N%", saved with the agent (PLAN 8.6)', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  const agent = {
    id: 'coder',
    name: 'Coder',
    role: '',
    runtime: 'claude-code',
    workspace: '/w',
    permission: 'workspace-write',
    model: null,
    style: { color: '#6B4EFF', shape: 'hexagon' },
    quota: 'q',
    quotaFloorPercent: 10,
    cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], confirmed: false },
    heldGroups: [],
    createdAt: '2026-10-11T00:00:00.000Z',
  }
  const patches: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push(body)
      return json({ ...agent, quotaFloorPercent: body.quotaFloorPercent })
    }
    if (path.endsWith('/quota')) return json({ quota: null })
    if (path.includes('/models')) return json({ models: [], source: 'none' })
    if (path.endsWith('/backend'))
      return json({ kind: 'unit', note: '', checks: [], checkedAt: '2026-10-11T00:00:00.000Z' })
    if (path.endsWith('/runtimes')) return json({ items: runtimes })
    return json({ items: [agent] })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CodingOverview agent={{ id: 'coder' } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const field = (await screen.findByLabelText(
    /Stop using this agent in runs when a limit is below/,
  )) as HTMLInputElement
  expect(field.value).toBe('10')
  expect(screen.getByText(/Enter 0 to turn this off/)).toBeTruthy()
  fireEvent.change(field, { target: { value: '60' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(field, { target: { value: '25' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toHaveLength(1))
  expect(patches[0]).toMatchObject({ quotaFloorPercent: 25 })
})

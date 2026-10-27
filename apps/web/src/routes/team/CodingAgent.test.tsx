import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AddCodingAgentForm } from './CodingAgent.tsx'
import { CodingPersonality } from './CodingPersonality.tsx'

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
    instructions: '',
    instructionsEtag: 'e0',
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
              instructions: '',
              instructionsEtag: 'e0',
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
    instructions: '',
    instructionsEtag: 'e0',
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
  fireEvent.click(await screen.findByRole('button', { name: 'Change access' }))
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

const personaAgent = (over: object = {}) => ({
  id: 'builder',
  name: 'Builder',
  role: 'Reviews build scripts',
  instructions: '## Style\n\nBe **brief**.',
  instructionsEtag: 'etag-1',
  runtime: 'claude-code',
  workspace: '/w',
  permission: 'workspace-write',
  model: null,
  style: { color: '#6B4EFF', shape: 'hexagon' },
  quota: 'q',
  quotaFloorPercent: 10,
  cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], confirmed: false },
  heldGroups: [],
  createdAt: '2026-10-17T00:00:00.000Z',
  ...over,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function renderPersonality(onChanged = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CodingPersonality coding={personaAgent() as never} onChanged={onChanged} />
    </QueryClientProvider>,
  )
}

test('Personality card: role line and rendered instructions; Edit opens the editor, Cancel closes it unsaved', async () => {
  renderPersonality()
  expect(screen.getByText('Reviews build scripts')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Style' })).toBeDefined()
  expect(screen.getByText('brief').tagName).toBe('STRONG')
  fireEvent.click(screen.getByRole('button', { name: 'Edit personality' }))
  const text = screen.getByLabelText('Personality and instructions') as HTMLTextAreaElement
  expect(text.value).toContain('Be **brief**.')
  fireEvent.change(text, { target: { value: 'changed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByLabelText('Personality and instructions')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Style' })).toBeDefined()
})

test('Personality editor: Save sends the role, the text and the etag it started from', async () => {
  const patches: unknown[] = []
  vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
    patches.push(JSON.parse(String(init?.body)))
    return json(personaAgent({ instructions: 'Be bold.', instructionsEtag: 'etag-2' }))
  })
  const changed = vi.fn()
  renderPersonality(changed)
  fireEvent.click(screen.getByRole('button', { name: 'Edit personality' }))
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  // Nothing changed yet.
  expect(save.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Personality and instructions'), {
    target: { value: 'Be bold.' },
  })
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Lead builder' } })
  fireEvent.click(save)
  await waitFor(() => expect(changed).toHaveBeenCalled())
  expect(patches).toEqual([
    { role: 'Lead builder', instructions: 'Be bold.', instructionsEtag: 'etag-1' },
  ])
})

test('Personality editor: only the role changed sends no instructions', async () => {
  const patches: unknown[] = []
  vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
    patches.push(JSON.parse(String(init?.body)))
    return json(personaAgent({ role: 'Lead builder' }))
  })
  renderPersonality()
  fireEvent.click(screen.getByRole('button', { name: 'Edit personality' }))
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Lead builder' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches.length).toBe(1))
  expect(patches[0]).toEqual({ role: 'Lead builder' })
})

test('Personality editor: a stale save says so in plain words, and Overwrite with mine resends against the newest etag', async () => {
  const patches: { instructionsEtag?: string }[] = []
  vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { instructionsEtag?: string }
    patches.push(body)
    if (body.instructionsEtag === 'etag-1')
      return json(
        {
          error: {
            code: 'conflict',
            message: 'These instructions were changed somewhere else.',
            details: { etag: 'etag-9', instructions: 'Their text.' },
          },
        },
        409,
      )
    return json(personaAgent({ instructions: 'Mine.', instructionsEtag: 'etag-10' }))
  })
  const changed = vi.fn()
  renderPersonality(changed)
  fireEvent.click(screen.getByRole('button', { name: 'Edit personality' }))
  fireEvent.change(screen.getByLabelText('Personality and instructions'), {
    target: { value: 'Mine.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('These instructions changed while you were editing')).toBeDefined()
  expect(screen.queryByText(/409|etag/i)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }))
  await waitFor(() => expect(changed).toHaveBeenCalled())
  expect(patches.map((patch) => patch.instructionsEtag)).toEqual(['etag-1', 'etag-9'])
})

test('Add form: the optional role is sent only when filled in', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AddCodingAgentForm onAdded={() => undefined} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole('option', { name: 'Claude Code' }, { timeout: 10_000 })
  fireEvent.change(screen.getByLabelText(/Agent name/), { target: { value: 'rev' } })
  fireEvent.change(screen.getByLabelText('Role (optional)'), { target: { value: 'Reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add coding agent' }))
  await waitFor(() => expect(posted.length).toBe(1))
  expect(posted[0]).toMatchObject({ id: 'rev', role: 'Reviewer' })
})

test('the Model and Access cards edit in place and each saves only its own fields', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  let agent = personaAgent({ model: 'sonnet' }) as Record<string, unknown>
  const patches: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push(body)
      agent = { ...agent, ...body }
      return json(agent)
    }
    if (path.endsWith('/quota')) return json({ quota: null })
    if (path.includes('/models')) return json({ models: [], source: 'none' })
    if (path.endsWith('/backend'))
      return json({
        kind: 'unit',
        note: 'Runs as a service.',
        checks: [],
        checkedAt: '2026-10-17T00:00:00.000Z',
      })
    if (path.endsWith('/runtimes')) return json({ items: runtimes })
    return json({ items: [agent] })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CodingOverview agent={{ id: 'builder' } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const model = await screen.findByRole('region', { name: 'Model' })
  expect(model.textContent).toContain('sonnet')
  fireEvent.click(within(model).getByRole('button', { name: 'Change model' }))
  const field = await within(model).findByRole('textbox', { name: /^Model/ })
  fireEvent.change(field, { target: { value: 'opus' } })
  fireEvent.click(within(model).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toEqual([{ model: 'opus' }]))

  const access = screen.getByRole('region', { name: 'Access' })
  expect(access.textContent).toContain('Workspace write')
  fireEvent.click(within(access).getByRole('button', { name: 'Change access' }))
  fireEvent.click(within(access).getByRole('radio', { name: /Read only/ }))
  fireEvent.click(within(access).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toHaveLength(2))
  expect(patches[1]).toEqual({ permission: 'read-only', quotaFloorPercent: 10 })
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Access' }).textContent).toContain('Read only'),
  )
  // Cancel leaves the card as it was.
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Access' })).getByRole('button', {
      name: 'Change access',
    }),
  )
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Access' })).getByRole('button', { name: 'Cancel' }),
  )
  expect(patches).toHaveLength(2)
})

test('Cancel drops the drafts and the typed password: reopening shows the saved values, and a floor-only save sends only the floor', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  const agent = personaAgent({ model: 'sonnet' })
  const patches: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push(body)
      return json({ ...agent, ...body })
    }
    if (path.endsWith('/quota')) return json({ quota: null })
    if (path.includes('/models')) return json({ models: [], source: 'none' })
    if (path.endsWith('/backend'))
      return json({ kind: 'unit', note: 'x', checks: [], checkedAt: '2026-10-17T00:00:00.000Z' })
    if (path.endsWith('/runtimes')) return json({ items: runtimes })
    return json({ items: [agent] })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CodingOverview agent={{ id: 'builder' } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const access = () => screen.getByRole('region', { name: 'Access' })
  fireEvent.click(await screen.findByRole('button', { name: 'Change access' }))
  fireEvent.click(within(access()).getByRole('radio', { name: /Full access/ }))
  fireEvent.change(within(access()).getByLabelText('Security password'), {
    target: { value: 'secret' },
  })
  fireEvent.change(within(access()).getByLabelText(/Stop using this agent/), {
    target: { value: '30' },
  })
  fireEvent.click(within(access()).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(access()).getByRole('button', { name: 'Change access' }))
  expect(
    (within(access()).getByRole('radio', { name: /Workspace write/ }) as HTMLInputElement).checked,
  ).toBe(true)
  expect(within(access()).queryByLabelText('Security password')).toBeNull()
  const floor = within(access()).getByLabelText(/Stop using this agent/) as HTMLInputElement
  expect(floor.value).toBe('10')
  fireEvent.change(floor, { target: { value: '20' } })
  fireEvent.click(within(access()).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toEqual([{ quotaFloorPercent: 20 }]))

  // The Model card does the same.
  const model = () => screen.getByRole('region', { name: 'Model' })
  fireEvent.click(within(model()).getByRole('button', { name: 'Change model' }))
  fireEvent.change(await within(model()).findByRole('textbox', { name: /^Model/ }), {
    target: { value: 'opus' },
  })
  fireEvent.click(within(model()).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(model()).getByRole('button', { name: 'Change model' }))
  expect(
    ((await within(model()).findByRole('textbox', { name: /^Model/ })) as HTMLInputElement).value,
  ).toBe('sonnet')
})

async function renderOverviewWithRefresh() {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  let agent = personaAgent() as Record<string, unknown>
  const patches: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return json(agent)
    }
    if (path.endsWith('/quota')) return json({ quota: null })
    if (path.includes('/models')) return json({ models: [], source: 'none' })
    if (path.endsWith('/backend'))
      return json({ kind: 'unit', note: 'x', checks: [], checkedAt: '2026-10-17T00:00:00.000Z' })
    if (path.endsWith('/runtimes')) return json({ items: runtimes })
    return json({ items: [agent] })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CodingOverview agent={{ id: 'builder' } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Edit personality' }))
  fireEvent.change(screen.getByLabelText('Personality and instructions'), {
    target: { value: 'My unsaved draft.' },
  })
  // Someone else saves newer instructions, then this page's coding-agent query refreshes.
  agent = { ...agent, instructions: 'Their newer text.', instructionsEtag: 'etag-2' }
  await client.invalidateQueries({ queryKey: ['coding'] })
  return { patches }
}

test('K3 X6: a refresh of the coding-agent query keeps the personality draft and offers the conflict choices', async () => {
  await renderOverviewWithRefresh()
  const field = (await screen.findByLabelText(
    'Personality and instructions',
  )) as HTMLTextAreaElement
  expect(field.value).toBe('My unsaved draft.')
  expect(await screen.findByText('These instructions changed while you were editing')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Reload theirs' }))
  expect((screen.getByLabelText('Personality and instructions') as HTMLTextAreaElement).value).toBe(
    'Their newer text.',
  )
  expect(screen.queryByText('These instructions changed while you were editing')).toBeNull()
})

test('K3 X6: Overwrite with mine saves the kept draft against the newer etag', async () => {
  const { patches } = await renderOverviewWithRefresh()
  fireEvent.click(await screen.findByRole('button', { name: 'Overwrite with mine' }))
  await waitFor(() => expect(patches).toHaveLength(1))
  expect(patches[0]).toMatchObject({
    instructions: 'My unsaved draft.',
    instructionsEtag: 'etag-2',
  })
})

test('the Model card offers Effort: Claude Code lists five levels, Codex the chosen model’s; Default sends null', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  for (const [runtimeName, levels, models] of [
    ['claude-code', ['low', 'medium', 'high', 'xhigh', 'max'], { models: [], source: 'none' }],
    [
      'codex',
      ['low', 'medium', 'high'],
      {
        models: [{ id: 'm-x', name: 'm-x', efforts: ['low', 'medium', 'high'] }],
        source: 'cli',
      },
    ],
  ] as const) {
    cleanup()
    let agent = personaAgent({
      runtime: runtimeName,
      model: runtimeName === 'codex' ? 'm-x' : null,
      effort: 'high',
    }) as Record<string, unknown>
    const patches: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        patches.push(body)
        agent = { ...agent, ...body }
        return json(agent)
      }
      if (path.endsWith('/quota')) return json({ quota: null })
      if (path.includes('/models')) return json(models)
      if (path.endsWith('/backend'))
        return json({ kind: 'unit', note: 'x', checks: [], checkedAt: '2026-10-17T00:00:00.000Z' })
      if (path.endsWith('/runtimes')) return json({ items: runtimes })
      return json({ items: [agent] })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CodingOverview agent={{ id: 'builder' } as never} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const model = await screen.findByRole('region', { name: 'Model' })
    expect(model.textContent).toContain('Effort: high')
    fireEvent.click(within(model).getByRole('button', { name: 'Change model' }))
    const select = (await within(model).findByRole('combobox', {
      name: 'Effort',
    })) as HTMLSelectElement
    await waitFor(() =>
      expect([...select.options].map((option) => option.value)).toEqual(['', ...levels]),
    )
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(within(model).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toMatchObject({ effort: null })
  }
})

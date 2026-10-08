import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, AgentSummary, SystemStatus } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  constructor(readonly url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {}
  frame(value: unknown, type: string, id = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value), lastEventId: id }))
  }
}

const system: SystemStatus = {
  mode: 'fake',
  hermes: { version: null, reachable: true, apiServer: true, capabilities: [], servedProfiles: [] },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
}

const lead: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Plans the work',
  style: { color: '#6b4eff', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: { id: 'm-1', label: 'Model One' },
  served: true,
}
const builder: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds it',
  style: { color: '#19c39a', shape: 'triangle' },
  status: 'working',
  activity: 'Writing the stream client',
  model: { id: 'm-2', label: 'Model Two' },
  served: true,
}
const builderDetail: AgentDetail = {
  ...builder,
  tagline: 'Builds what Lead plans.',
  personality: { excerpt: 'Calm and precise.', source: 'SOUL.md' },
  reportsTo: 'lead',
  worksIn: '/srv/app',
  rulesFile: 'AGENTS.md',
  model: { id: 'm-2', label: 'Model Two', via: 'a sign-in', fallback: null },
  skills: [{ name: 'Git', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal', kind: 'builtin', enabled: true }],
  helpersMax: 3,
  routines: [],
  channels: [],
  permissions: [{ id: 'push', label: 'Push to git', level: 'asks', inherited: false }],
}

type Responder = (path: string, init?: RequestInit) => Response | Promise<Response>
let respond: Responder
let router: ReturnType<typeof createMemoryRouter>
let stream: ReturnType<typeof createStreamClient>
let registry: ReturnType<typeof createStreamQueryRegistry>
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function renderTeam(path: string) {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  const source = MockEventSource.instances.at(-1)!
  act(() => {
    source.frame(
      { type: 'stream.hello', data: { epoch: 'e1', headSeq: 0, mode: 'fake', system } },
      'stream.hello',
    )
  })
  return source
}

function agentUpdated(source: MockEventSource, seq: number, agent: AgentSummary) {
  act(() => {
    source.frame(
      { seq, ts: '2026-01-01T00:00:00.000Z', type: 'agent.updated', data: agent },
      'agent.updated',
      String(seq),
    )
  })
}

beforeEach(() => {
  MockEventSource.instances = []
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: [lead, builder] })
    if (path === '/api/agents/builder') return json(builderDetail)
    return json({ error: { code: 'not_found', message: 'No such agent' } }, 404)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => Promise.resolve(respond(path, init))),
  )
})
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('list shows a loading state, then each agent with role, status, activity and model', async () => {
  renderTeam('/team')
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Loading agents…')
  const card = (await screen.findByRole('heading', { name: 'Builder', level: 2 })).closest('a')!
  expect(card.getAttribute('href')).toBe('/team/builder')
  expect(within(card).getByRole('img', { name: 'Builder, triangle' })).toBeDefined()
  for (const text of ['Builds it', 'Working', 'Writing the stream client', 'Model Two'])
    expect(within(card).getByText(text)).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Team', level: 1 })).toBeDefined()
  expect(
    within(screen.getByRole('navigation', { name: 'Team members' })).getAllByRole('link'),
  ).toHaveLength(3)
})

test('list shows an empty state', async () => {
  respond = () => json({ asOfSeq: 0, items: [] })
  renderTeam('/team')
  expect(await screen.findByRole('heading', { name: 'No agents yet' })).toBeDefined()
})

test('list shows an error with a retry that recovers', async () => {
  respond = () => json({ error: { code: 'boom', message: 'Down' } }, 500)
  renderTeam('/team')
  const alert = await screen.findByRole('alert')
  respond = () => json({ asOfSeq: 0, items: [lead] })
  fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('heading', { name: 'Lead', level: 2 })).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('a live agent.updated event changes the list and the open profile', async () => {
  const source = renderTeam('/team/builder')
  expect(await screen.findByRole('heading', { name: 'Builder', level: 1 })).toBeDefined()
  expect(screen.getByText(/Working · Writing the stream client/)).toBeDefined()
  agentUpdated(source, 1, { ...builder, status: 'waiting', activity: 'Asking for approval' })
  expect(await screen.findByText(/Needs you · Asking for approval/)).toBeDefined()
  act(() => void router.navigate('/team'))
  expect(await screen.findByText('Asking for approval')).toBeDefined()
})

test('profile shows the header band, tabs and overview cards from the detail', async () => {
  renderTeam('/team/builder')
  expect(await screen.findByRole('heading', { name: 'Builder', level: 1 })).toBeDefined()
  expect(screen.getByText('Builds what Lead plans.')).toBeDefined()
  expect(screen.getByRole('tablist', { name: "Builder's settings" })).toBeDefined()
  expect(screen.getAllByRole('tab')).toHaveLength(10)
  expect(screen.getByText('Calm and precise.')).toBeDefined()
  expect(
    within(screen.getByRole('main').querySelector('.team-facts')! as HTMLElement)
      .getByRole('link', { name: 'Lead' })
      .getAttribute('href'),
  ).toBe('/team/lead')
  expect(screen.getByText('/srv/app')).toBeDefined()
  expect(screen.getByText('AGENTS.md')).toBeDefined()
  expect(screen.getByText('Model Two')).toBeDefined()
  expect(screen.getByText('Through a sign-in. No fallback configured.')).toBeDefined()
  expect(screen.getByText('Git')).toBeDefined()
  expect(screen.getByText('Up to 3')).toBeDefined()
  expect(screen.getByText('Asks you')).toBeDefined()
})

test('profile copes with an unreadable model', async () => {
  const detail = { ...builderDetail, model: null }
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: [{ ...builder, model: null }] })
      : json(detail)
  renderTeam('/team/builder')
  expect(await screen.findByText('Model unavailable')).toBeDefined()
})

test('profile shows an error for an unknown agent', async () => {
  renderTeam('/team/ghost')
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Agent unavailable')).toBeDefined()
})

test('tabs move with the arrow keys and other tabs show a coming-soon panel', async () => {
  renderTeam('/team/builder')
  const overview = await screen.findByRole('tab', { name: 'Overview' })
  expect(overview.getAttribute('aria-selected')).toBe('true')
  overview.focus()
  fireEvent.keyDown(overview, { key: 'ArrowRight' })
  const personality = screen.getByRole('tab', { name: 'Personality' })
  expect(document.activeElement).toBe(personality)
  expect(personality.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(personality, { key: 'ArrowRight' })
  expect(within(screen.getByRole('tabpanel')).getByText(/coming soon/)).toBeDefined()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'History' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(document.activeElement).toBe(overview)
})

test('the glyph popover saves a new color and shape with the CSRF header', async () => {
  const source = renderTeam('/team/builder')
  const calls: { path: string; init?: RequestInit }[] = []
  const baseline = respond
  respond = (path, init) => {
    if (init?.method === 'PATCH') {
      calls.push({ path, init })
      return json({ ...builder, style: { color: '#ff6b8a', shape: 'star' } })
    }
    return baseline(path, init)
  }
  fireEvent.click(await screen.findByRole('button', { name: "Change Builder's color and shape" }))
  const dialog = screen.getByRole('dialog', { name: 'Agent appearance' })
  fireEvent.change(within(dialog).getByLabelText('Color'), { target: { value: '#ff6b8a' } })
  fireEvent.change(within(dialog).getByLabelText('Shape'), { target: { value: 'star' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save appearance' }))
  await waitFor(() => expect(calls).toHaveLength(1))
  expect(calls[0]!.path).toBe('/api/agents/builder/style')
  expect(new Headers(calls[0]!.init?.headers).get('X-Score-Client')).toBe('web')
  expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ color: '#ff6b8a', shape: 'star' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // The server also announces the change; the page follows the stream.
  agentUpdated(source, 1, { ...builder, style: { color: '#ff6b8a', shape: 'star' } })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: "Change Builder's color and shape" }),
  )
})

test('the glyph popover closes with Escape and reports a failed save', async () => {
  renderTeam('/team/builder')
  const baseline = respond
  respond = (path, init) =>
    init?.method === 'PATCH'
      ? json({ error: { code: 'not_paired', message: 'Pair first' } }, 403)
      : baseline(path, init)
  const trigger = await screen.findByRole('button', { name: "Change Builder's color and shape" })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Save appearance' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Pair this browser/)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

const digest = {
  id: 'builder:abc123',
  title: 'Morning digest',
  schedule: '0 9 * * *',
  description: 'Summarise yesterday.',
  lastRunAt: null,
  enabled: true,
}
// A small stand-in for the routines endpoints that keeps the list the tab re-reads.
function routinesApi(initial = [digest]) {
  let items = [...initial]
  const calls: { method: string; path: string; init?: RequestInit }[] = []
  const baseline = respond
  respond = (path, init) => {
    const method = init?.method ?? 'GET'
    if (path === '/api/agents/builder/routines' && method === 'GET') return json({ items })
    if (path.startsWith('/api/agents/builder/routines') || path.startsWith('/api/routines/')) {
      calls.push({ method, path, init })
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (method === 'POST' && path.endsWith('/routines')) {
        const created = {
          ...digest,
          id: 'builder:new1',
          title: body.title,
          schedule: body.schedule,
        }
        items = [...items, created]
        return json(created)
      }
      if (method === 'PATCH') {
        items = items.map((item) => ({ ...item, enabled: body.enabled }))
        return json(items[0])
      }
      if (method === 'DELETE') items = []
      return json({ id: 'builder:abc123', queued: true })
    }
    return baseline(path, init)
  }
  return calls
}

test('the Routines tab lists routines and pauses, runs and deletes them', async () => {
  renderTeam('/team/builder')
  const calls = routinesApi()
  fireEvent.click(await screen.findByRole('tab', { name: 'Routines' }))
  const row = (await screen.findByText('Morning digest')).closest('li')!
  expect(within(row).getByText('0 9 * * *')).toBeDefined()
  expect(within(row).getByText('Not run yet')).toBeDefined()

  fireEvent.click(within(row).getByRole('button', { name: 'Pause Morning digest' }))
  expect(await screen.findByRole('button', { name: 'Resume Morning digest' })).toBeDefined()
  expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/routines/builder%3Aabc123' })
  expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ enabled: false })
  expect(new Headers(calls.at(-1)!.init?.headers).get('Idempotency-Key')).toBeTruthy()
  expect(screen.getByText(/Morning digest · Paused/)).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Run Morning digest now' }))
  expect((await screen.findAllByText(/will run on the next tick/)).length).toBeGreaterThan(0)
  expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/routines/builder%3Aabc123/run' })

  fireEvent.click(screen.getByRole('button', { name: 'Delete Morning digest' }))
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting Morning digest' }))
  expect(await screen.findByText('No routines configured.')).toBeDefined()
})

test('the create form sends the routine once per submission and shows it', async () => {
  renderTeam('/team/builder')
  const calls = routinesApi([])
  fireEvent.click(await screen.findByRole('tab', { name: 'Routines' }))
  expect(await screen.findByText('No routines configured.')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'New routine' }))
  const form = screen.getByRole('form', { name: 'New routine' })
  fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Build check' } })
  fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: 'every 2h' } })
  fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'Check the build.' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }))
  expect(await screen.findByText('Build check')).toBeDefined()
  const post = calls.find((call) => call.method === 'POST')!
  expect(post.path).toBe('/api/agents/builder/routines')
  expect(JSON.parse(String(post.init?.body))).toEqual({
    title: 'Build check',
    schedule: 'every 2h',
    prompt: 'Check the build.',
  })
  expect(new Headers(post.init?.headers).get('Idempotency-Key')).toBeTruthy()
  expect(screen.queryByRole('form', { name: 'New routine' })).toBeNull()
})

test('a failed create keeps the form and reuses its key on retry', async () => {
  renderTeam('/team/builder')
  routinesApi([])
  const keys: string[] = []
  const baseline = respond
  respond = (path, init) => {
    if (init?.method === 'POST' && path.endsWith('/routines')) {
      keys.push(new Headers(init.headers).get('Idempotency-Key')!)
      return keys.length === 1
        ? json({ error: { code: 'not_paired', message: 'Pair first' } }, 403)
        : baseline(path, init)
    }
    return baseline(path, init)
  }
  fireEvent.click(await screen.findByRole('tab', { name: 'Routines' }))
  fireEvent.click(await screen.findByRole('button', { name: 'New routine' }))
  const form = screen.getByRole('form', { name: 'New routine' })
  fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Build check' } })
  fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: 'every 2h' } })
  fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'Check it.' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }))
  expect((await within(form).findByRole('alert')).textContent).toMatch(/Pair this browser/)
  fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }))
  await waitFor(() => expect(keys).toHaveLength(2))
  expect(keys[0]).toBe(keys[1])
})

test('the Overview New routine link opens the form on the Routines tab', async () => {
  renderTeam('/team/builder')
  routinesApi([])
  fireEvent.click(await screen.findByRole('button', { name: 'New routine' }))
  expect(screen.getByRole('tab', { name: 'Routines' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('form', { name: 'New routine' })).toBeDefined()
})

const etagA = 'a'.repeat(64)
const etagB = 'b'.repeat(64)
const etagC = 'c'.repeat(64)
function filesResponder(calls: { path: string; init?: RequestInit }[]) {
  const baseline = respond
  respond = (path, init) => {
    if (path === '/api/agents/builder/files/SOUL.md' && init?.method === 'GET')
      return json({ content: 'Calm and precise.\n', etag: etagA })
    if (path === '/api/agents/builder/files/AGENTS.md' && init?.method === 'GET')
      return json({ content: '', etag: etagC })
    if (path.includes('/files/')) {
      calls.push({ path, init })
      return fileMutation(path, init)
    }
    return baseline(path, init)
  }
}
let fileMutation: Responder
async function openEditor() {
  renderTeam('/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Edit personality' }))
  return screen.findByRole('textbox', { name: 'SOUL.md contents' })
}

test('the Personality editor previews the diff and saves with the etag', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  fileMutation = (path) =>
    path.endsWith('/preview')
      ? json({ diff: '--- current\n+++ proposed\n@@ -1,1 +1,1 @@\n-Calm and precise.\n+Bold.' })
      : json({ etag: etagB })
  filesResponder(calls)
  const box = await openEditor()
  const save = screen.getByRole('button', { name: 'Save' })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.change(box, { target: { value: 'Bold.\n' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }))
  const diff = await screen.findByLabelText('Changes to save')
  expect(diff.textContent).toContain('+Bold.')
  expect(calls[0]!.init!.body).toBe(JSON.stringify({ content: 'Bold.\n' }))
  fireEvent.click(save)
  await screen.findByText('Saved SOUL.md.')
  const put = calls.find((call) => call.init?.method === 'PUT')!
  expect(JSON.parse(String(put.init!.body))).toEqual({ content: 'Bold.\n', etag: etagA })
  expect(new Headers(put.init!.headers).get('X-Score-Client')).toBe('web')
  expect(new Headers(put.init!.headers).get('Idempotency-Key')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
})

test('a 409 shows the server diff; Overwrite with mine re-saves with the new etag', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  let puts = 0
  fileMutation = () =>
    ++puts === 1
      ? json(
          {
            error: {
              code: 'conflict',
              message: 'The file changed',
              details: { etag: etagB, diff: '--- current\n+++ proposed\n-Theirs\n+Mine' },
            },
          },
          409,
        )
      : json({ etag: etagC })
  filesResponder(calls)
  const box = await openEditor()
  fireEvent.change(box, { target: { value: 'Mine\n' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  const diff = await screen.findByLabelText('Their version compared with yours')
  expect(diff.textContent).toContain('-Theirs')
  expect(diff.textContent).toContain('+Mine')
  expect((box as HTMLTextAreaElement).value).toBe('Mine\n')
  fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }))
  await screen.findByText('Saved SOUL.md.')
  const bodies = calls
    .filter((c) => c.init?.method === 'PUT')
    .map((c) => JSON.parse(String(c.init!.body)))
  expect(bodies).toEqual([
    { content: 'Mine\n', etag: etagA },
    { content: 'Mine\n', etag: etagB },
  ])
  expect(screen.queryByLabelText('Their version compared with yours')).toBeNull()
})

test('Reload theirs discards the draft and loads the current file', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  fileMutation = () =>
    json(
      { error: { code: 'conflict', message: 'x', details: { etag: etagB, diff: '-a\n+b' } } },
      409,
    )
  filesResponder(calls)
  const box = await openEditor()
  fireEvent.change(box, { target: { value: 'Mine\n' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByLabelText('Their version compared with yours')
  const baseline = respond
  respond = (path, init) =>
    path === '/api/agents/builder/files/SOUL.md' && init?.method === 'GET'
      ? json({ content: 'Theirs\n', etag: etagB })
      : baseline(path, init)
  fireEvent.click(screen.getByRole('button', { name: 'Reload theirs' }))
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('Theirs\n'))
  expect(screen.queryByLabelText('Their version compared with yours')).toBeNull()
})

test('the rules file opens from the overview and drafts survive switching files', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  fileMutation = () => json({ etag: etagB })
  filesResponder(calls)
  renderTeam('/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Edit rules' }))
  const rules = await screen.findByRole('textbox', { name: 'AGENTS.md contents' })
  fireEvent.change(rules, { target: { value: '- be nice\n' } })
  fireEvent.click(screen.getByRole('button', { name: /Personality · SOUL.md/ }))
  await screen.findByRole('textbox', { name: 'SOUL.md contents' })
  fireEvent.click(screen.getByRole('button', { name: /Operating rules · AGENTS.md/ }))
  const again = await screen.findByRole('textbox', { name: 'AGENTS.md contents' })
  expect((again as HTMLTextAreaElement).value).toBe('- be nice\n')
})

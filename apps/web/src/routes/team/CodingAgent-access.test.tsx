import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import {
  installCodingAgentTestSetup,
  json,
  personaAgent,
  runtimes,
} from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

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
    cli: { state: 'ready', version: '1.0.0', testedVersions: ['1.0.0'], problem: null },
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

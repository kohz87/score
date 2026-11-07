import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import {
  installCodingAgentTestSetup,
  json,
  personaAgent,
  runtimes,
} from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

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

test('Codex: choosing a model that does not list the current effort resets it to Default and never sends it', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  let agent = personaAgent({ runtime: 'codex', model: 'big', effort: 'xhigh' }) as Record<
    string,
    unknown
  >
  const patches: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      patches.push(body)
      agent = { ...agent, ...body }
      return json(agent)
    }
    if (path.endsWith('/quota')) return json({ quota: null })
    if (path.includes('/models'))
      return json({
        source: 'cli',
        models: [
          { id: 'big', name: 'big', efforts: ['low', 'xhigh'] },
          { id: 'small', name: 'small', efforts: ['low', 'medium'] },
        ],
      })
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
  fireEvent.click(within(model).getByRole('button', { name: 'Change model' }))
  const effort = (await within(model).findByRole('combobox', {
    name: 'Effort',
  })) as HTMLSelectElement
  const picker = (await within(model).findByRole('combobox', {
    name: 'Model',
  })) as HTMLSelectElement
  await waitFor(() => expect(picker.querySelector('option[value="small"]')).not.toBeNull())
  expect(effort.value).toBe('xhigh')
  fireEvent.change(picker, { target: { value: 'small' } })
  await waitFor(() => expect(effort.value).toBe(''))
  fireEvent.click(within(model).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toHaveLength(1))
  expect(patches[0]).toEqual({ model: 'small', effort: null })
})

test('3.14.1: a Claude Code agent picks its own advisor: only stronger models, off again when the model catches up', async () => {
  const { CodingOverview } = await import('./CodingAgent.tsx')
  let agent = personaAgent({
    runtime: 'claude-code',
    model: 'sonnet',
    advisorModel: null,
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
  const model = await screen.findByRole('region', { name: 'Model' })
  expect(model.textContent).toContain('Advisor: Off')
  fireEvent.click(within(model).getByRole('button', { name: 'Change model' }))
  const advisor = (await within(model).findByRole('combobox', {
    name: 'Advisor',
  })) as HTMLSelectElement
  expect([...advisor.options].map((option) => option.value)).toEqual(['', 'opus', 'fable'])
  fireEvent.change(advisor, { target: { value: 'opus' } })
  // A model as strong as the advisor turns it off, and says so.
  const modelBox = (await within(model).findByRole('textbox')) as HTMLInputElement
  fireEvent.change(modelBox, { target: { value: 'opus' } })
  await waitFor(() => expect(advisor.value).toBe(''))
  expect(within(model).getByRole('status').textContent).toMatch(/Advisor turned off/)
  // Any later model change clears it.
  fireEvent.change(modelBox, { target: { value: 'sonnet' } })
  expect(within(model).getByRole('status').textContent).toBe('')
  fireEvent.change(advisor, { target: { value: 'opus' } })
  expect(within(model).queryByText(/Advisor turned off/)).toBeNull()
  fireEvent.click(within(model).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(patches).toHaveLength(1))
  expect(patches[0]).toMatchObject({ advisorModel: 'opus' })
  // The card remounts with the saved agent.
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Model' }).textContent).toContain('Advisor: Opus'),
  )
})

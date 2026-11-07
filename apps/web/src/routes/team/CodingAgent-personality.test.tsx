import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import { CodingPersonality } from './CodingPersonality.tsx'
import {
  installCodingAgentTestSetup,
  json,
  personaAgent,
  runtimes,
} from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

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

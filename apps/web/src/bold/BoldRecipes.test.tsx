import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  okValidation,
  releaseDefinition,
  releaseDetail,
  releaseVersion,
  workflowFixtures,
} from '../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldRecipes } from './BoldRecipes.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const agents = [
  {
    id: 'builder',
    name: 'builder',
    role: '',
    style: { color: '#19C39A', shape: 'square' },
    status: 'idle',
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: '',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
  },
]

let requests: { url: string; init?: RequestInit }[]
const disposers: (() => void)[] = []

beforeEach(() => {
  requests = []
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      const method = init?.method ?? 'GET'
      if (url === '/api/workflows/validate' && method === 'POST')
        return Promise.resolve(json(okValidation))
      if (url === '/api/workflows/wf-release/versions' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { definition: typeof releaseDefinition }
        return Promise.resolve(json({ ...releaseVersion, version: 2, definition: body.definition }))
      }
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
      const fixture = workflowFixtures[url]
      return Promise.resolve(
        fixture === undefined
          ? json({ error: { code: 'not_found', message: 'none' } }, 404)
          : json(fixture),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(onClose = vi.fn()) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <MemoryRouter>
          <BoldRecipes onClose={onClose} />
        </MemoryRouter>
      </StreamContext>
    </QueryClientProvider>,
  )
  return onClose
}

const saveButton = () =>
  screen.getByRole('button', { name: 'Save as version 2' }) as HTMLButtonElement

test('the release recipe loads as seven numbered steps, is checked live, and undo/redo walks the draft', async () => {
  mount()
  const steps = await screen.findByRole('list', { name: 'Steps' })
  const dialog = screen.getByRole('dialog', { name: 'Recipe editor' })
  // The classic list is no longer linked; what only it showed, a recipe's run status, sits in the editor.
  expect(within(dialog).queryByRole('link', { name: 'Workflow runs and versions' })).toBeNull()
  const status = await within(dialog).findByLabelText('Runs of this recipe')
  expect(status.textContent).toContain('1 run going')
  expect(within(status).getByRole('link', { name: 'Running' }).getAttribute('href')).toMatch(
    /^\/b\/runs\/brief-/,
  )
  await waitFor(() => expect(within(steps).getAllByRole('listitem')).toHaveLength(7))
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  expect(requests.some((request) => request.url === '/api/workflows/validate')).toBe(true)

  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  const title = within(dialog).getByRole('textbox', { name: 'Title' })
  fireEvent.change(title, { target: { value: 'Review the copy' } })
  expect(within(steps).getByRole('button', { name: /^2.*Review the copy/ })).toBeTruthy()

  fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true })
  expect(within(steps).getByRole('button', { name: /^2.*Review the draft/ })).toBeTruthy()
  fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true, shiftKey: true })
  expect(within(steps).getByRole('button', { name: /^2.*Review the copy/ })).toBeTruthy()

  fireEvent.change(title, { target: { value: 'Typed, not undone' } })
  fireEvent.keyDown(title, { key: 'z', ctrlKey: true })
  expect((title as HTMLInputElement).value).toBe('Typed, not undone')
})

test('a dirty draft asks before Escape or a scrim click closes it', async () => {
  const onClose = mount()
  await screen.findByRole('list', { name: 'Steps' })
  const dialog = screen.getByRole('dialog', { name: 'Recipe editor' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Changed' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Close without saving?')
  expect(onClose).not.toHaveBeenCalled()

  confirm.mockReturnValue(true)
  fireEvent.mouseDown(dialog.parentElement!)
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('a failed validation check says so and keeps Save disabled', async () => {
  const fetchMock = vi.mocked(fetch)
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) => {
    if (String(input) === '/api/workflows/validate' && init?.method === 'POST')
      return Promise.resolve(json({ error: { code: 'internal', message: 'check failed' } }, 500))
    return original(input, init)
  })
  mount()

  expect(await screen.findByText("Couldn't check this recipe")).toBeTruthy()
  await waitFor(() => expect(saveButton().disabled).toBe(true))
})

test('a branch target changed from its row is saved as the same graph on a new version', async () => {
  mount()
  const target = await screen.findByRole('combobox', {
    name: 'Passed review?: otherwise goes to',
  })
  fireEvent.change(target, { target: { value: 'repaired' } })
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  fireEvent.click(saveButton())

  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/wf-release/versions')).toBe(
      true,
    ),
  )
  const saved = requests.find((request) => request.url === '/api/workflows/wf-release/versions')!
  const body = JSON.parse(String(saved.init?.body)) as {
    baseVersion: number
    definition: typeof releaseDetail.latest.definition
  }
  expect(body.baseVersion).toBe(1)
  expect(body.definition.nodes.map((node) => node.id)).toEqual(
    releaseDetail.latest.definition.nodes.map((node) => node.id),
  )
  expect(body.definition.edges.find((edge) => edge.id === 'e5')).toMatchObject({
    from: 'passed',
    port: 'default',
    to: 'repaired',
  })
  expect(await screen.findByText('Saved as version 2.')).toBeTruthy()
})

test('a conflict offers both classic choices and keeps the draft', async () => {
  mount()
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  const fetchMock = vi.mocked(fetch)
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) => {
    const url = String(input)
    if (url === '/api/workflows/wf-release/versions' && init?.method === 'POST')
      return Promise.resolve(
        json(
          { error: { code: 'conflict', message: 'newer version', details: { latestVersion: 4 } } },
          409,
        ),
      )
    return original(input, init)
  })
  fireEvent.click(saveButton())
  const conflict = await screen.findByRole('alert', { name: 'Someone saved first' })
  expect(
    within(conflict).getByRole('button', { name: 'Reload version 4 (discard my edits)' }),
  ).toBeTruthy()
  expect(
    within(conflict).getByRole('button', { name: 'Keep my draft and build on version 4' }),
  ).toBeTruthy()
  fireEvent.click(
    within(conflict).getByRole('button', { name: 'Keep my draft and build on version 4' }),
  )
  expect(await screen.findByRole('button', { name: 'Save as version 5' })).toBeTruthy()
})

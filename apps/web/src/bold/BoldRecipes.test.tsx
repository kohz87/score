import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  okValidation,
  releaseDefinition,
  releaseDetail,
  releaseVersion,
  unfinishedValidation,
  workflowFixtures,
} from '../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldRecipesPage } from './BoldRecipes.tsx'

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
    activity: null,
    model: null,
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: '',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    activity: null,
    model: null,
    served: true,
  },
]

let requests: { url: string; init?: RequestInit }[]
let post: (url: string, init?: RequestInit) => Response | undefined
const disposers: (() => void)[] = []
const dispose = disposers

beforeEach(() => {
  requests = []
  post = () => undefined
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
      if (method === 'POST') {
        const custom = post(url, init)
        if (custom) return Promise.resolve(custom)
      }
      if (url === '/api/workflows/validate' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { definition: { name: string } }
        return Promise.resolve(
          json(body.definition.name.includes('(draft)') ? unfinishedValidation : okValidation),
        )
      }
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

function mount(path = '/b/settings/recipes/wf-release') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      { path: '/b/settings/recipes', Component: BoldRecipesPage },
      { path: '/b/settings/recipes/:workflowId', Component: BoldRecipesPage },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [path] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

const saveButton = () =>
  screen.getByRole('button', { name: 'Save as version 2' }) as HTMLButtonElement

/** The editor opens on the graph; the step list is the "As text" tab. */
async function showText() {
  fireEvent.click(await screen.findByRole('tab', { name: 'As text' }))
  return screen.findByRole('list', { name: 'Steps' })
}

test('the release recipe loads as seven numbered steps, is checked live, and undo/redo walks the draft', async () => {
  mount()
  const steps = await showText()
  const dialog = screen.getByRole('region', { name: 'Recipe editor' })
  await waitFor(() => expect(within(steps).getAllByRole('listitem')).toHaveLength(7))
  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/validate')).toBe(true),
  )

  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  const title = screen.getByRole('textbox', { name: 'Title' })
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

test('a dirty draft asks before leaving for the library', async () => {
  const router = mount()
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Changed' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

  fireEvent.click(screen.getByRole('link', { name: '‹ Recipes' }))
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?'),
  )
  expect(router.state.location.pathname).toBe('/b/settings/recipes/wf-release')

  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('link', { name: '‹ Recipes' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
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
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Edited' } })
  await waitFor(() => expect(saveButton().disabled).toBe(true))
})

test('a branch target changed from its row is saved as the same graph on a new version', async () => {
  mount()
  await showText()
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
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Edited' } })
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

test('Recipes is a library of cards: the built-in one first, no editor open, each card with what it does and its links', async () => {
  const router = mount('/b/settings/recipes')
  expect(await screen.findByRole('heading', { name: 'Recipes' })).toBeTruthy()
  // Landing never opens an editor, and never makes an "Untitled recipe".
  expect(screen.queryByRole('region', { name: 'Recipe editor' })).toBeNull()
  expect(screen.queryByDisplayValue('Untitled recipe')).toBeNull()
  const lead = await screen.findByRole('listitem', { name: 'lead decides' })
  expect(within(lead).getByText('Built in')).toBeTruthy()
  expect(within(lead).getByText('Not run yet')).toBeTruthy()
  // Built in has no Edit.
  expect(within(lead).queryByRole('link', { name: /^Edit/ })).toBeNull()
  const card = await screen.findByRole('listitem', { name: 'Release notes' })
  expect(within(card).getByText('version 1')).toBeTruthy()
  // What it does: the steps, who does them, the approval, the inputs.
  await waitFor(() => expect(card.textContent).toMatch(/\d+ steps? · .*builder.*reviewer/))
  expect(card.textContent).toContain('input: topic')
  expect(card.textContent).toContain('your approval')
  // The last run opens in its chat (`/b?run=`), not on a run page.
  const last = within(card).getByRole('link', { name: /Running/ })
  expect(last.getAttribute('href')).toBe('/b?run=brief-wfrun-1')
  expect(card.textContent).toContain('Last run ·')
  expect(within(card).getByRole('link', { name: /^Edit/ }).getAttribute('href')).toBe(
    '/b/settings/recipes/wf-release',
  )
  // Run in a chat… is Start a job with this recipe chosen.
  fireEvent.click(within(card).getByRole('button', { name: /^Run in a chat…/ }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b'))
  expect(router.state.location.search).toBe('?start=job&recipe=wf-release')
})

test('a library card fetches its recipe only once it scrolls into view', async () => {
  const watched = new Map<
    Element,
    { cb: IntersectionObserverCallback; self: IntersectionObserver }
  >()
  class FakeObserver {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(node: Element) {
      watched.set(node, { cb: this.cb, self: this as unknown as IntersectionObserver })
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  mount('/b/settings/recipes')
  const card = await screen.findByRole('listitem', { name: 'Release notes' })
  const detailCalls = () => requests.filter((item) => item.url === '/api/workflows/wf-release')
  // Give the list a moment: nothing was fetched for a card nobody has seen.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(detailCalls()).toHaveLength(0)
  const { cb, self } = watched.get(card)!
  cb([{ isIntersecting: true, target: card } as unknown as IntersectionObserverEntry], self)
  await waitFor(() => expect(detailCalls()).toHaveLength(1))
  await waitFor(() => expect(card.textContent).toMatch(/\d+ steps?/))
})

test('the library is searchable, New recipe opens an editor, and lead decides is a page with a way to start a job', async () => {
  const router = mount('/b/settings/recipes')
  await screen.findByRole('listitem', { name: 'Release notes' })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a recipe' }), {
    target: { value: 'zzz' },
  })
  expect(await screen.findByText('No recipe matches “zzz”.')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a recipe' }), {
    target: { value: 'release' },
  })
  expect(screen.queryByRole('listitem', { name: 'lead decides' })).toBeNull()
  expect(screen.getByRole('listitem', { name: 'Release notes' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'New recipe' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes/new'))
  expect(await screen.findByDisplayValue('Untitled recipe')).toBeTruthy()
  expect(screen.getByRole('link', { name: '‹ Recipes' }).getAttribute('href')).toBe(
    '/b/settings/recipes',
  )

  cleanup()
  mount('/b/settings/recipes/lead-decides')
  expect(await screen.findByRole('heading', { name: 'lead decides' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Start a job' }).getAttribute('href')).toBe(
    '/b?start=job',
  )
})

test('archived recipes sit behind "Archived recipes · N" and can be unarchived', async () => {
  const fetchMock = vi.mocked(fetch)
  const original = fetchMock.getMockImplementation()!
  const archivedAt = '2026-11-01T10:00:00.000Z'
  fetchMock.mockImplementation((input, init) => {
    if (String(input) === '/api/workflows' && (init?.method ?? 'GET') === 'GET') {
      const list = workflowFixtures['/api/workflows'] as {
        items: { id: string; archivedAt: string | null }[]
      }
      return Promise.resolve(
        json({
          ...list,
          items: list.items.map((item) =>
            item.id === 'wf-draft' ? { ...item, archivedAt } : item,
          ),
        }),
      )
    }
    return original(input, init)
  })
  mount('/b/settings/recipes')
  await screen.findByRole('listitem', { name: 'Release notes' })
  expect(screen.queryByRole('listitem', { name: 'Release checks (draft)' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Archived recipes · 1' }))
  const card = await screen.findByRole('listitem', { name: 'Release checks (draft)' })
  expect(
    within(card).getByRole('button', { name: 'Unarchive Release checks (draft)' }),
  ).toBeTruthy()
  // An archived recipe is not offered in Start a job.
  expect(within(card).queryByRole('button', { name: /^Run in a chat/ })).toBeNull()
})

test('a run that belongs to no chat opens a read-only sheet over the library, not a run page', async () => {
  const router = mount('/b/settings/recipes?run=brief-wfrun-1')
  const sheet = await screen.findByRole('dialog', { name: /Run: Release notes: the 2.4 release/ })
  expect(within(sheet).getByText(/This run belongs to no chat/)).toBeTruthy()
  expect(within(sheet).queryByText(/Read-only/)).toBeNull()
  // A stuck chat-less run must still be stoppable: the controls are in the sheet.
  expect(await within(sheet).findByRole('button', { name: 'Pause' })).toBeTruthy()
  expect(within(sheet).getByRole('button', { name: 'Stop' })).toBeTruthy()
  // The same parts as a chat's Graph tab: the graph, the session log and the folded Run details.
  expect(await within(sheet).findByRole('region', { name: 'Session log' })).toBeTruthy()
  expect(within(sheet).getByText('Run details')).toBeTruthy()
  // The old run frame is gone.
  expect(screen.queryByRole('button', { name: 'All runs' })).toBeNull()
  expect(screen.queryByRole('tab', { name: 'Steps' })).toBeNull()
  // The library is still there under it; closing returns to it.
  expect(screen.getByRole('heading', { name: 'Recipes' })).toBeTruthy()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close the run' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(router.state.location.search).toBe('')
})

test('the sheet is a native modal dialog and Escape closes it', async () => {
  const router = mount('/b/settings/recipes?run=brief-wfrun-1')
  const sheet = (await screen.findByRole('dialog', { name: /Run: / })) as HTMLDialogElement
  expect(sheet.tagName).toBe('DIALOG')
  // jsdom has no showModal; the browser's own dialog supplies the focus trap, the inert page and Escape.
  fireEvent(sheet, new Event('close'))
  await waitFor(() => expect(router.state.location.search).toBe(''))
})

test('a recipe run that has agents changed says so above the graph, protected, with the run controls', async () => {
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflow-runs/wfrun-1'] as {
    run: { agentMap: unknown[] }
  }
  fixtures['/api/workflow-runs/wfrun-1'] = {
    ...original,
    run: {
      ...original.run,
      agentMap: [
        { agentId: 'builder', incarnation: 'new-builder', status: 'changed' },
        { agentId: 'reviewer', incarnation: 'old-reviewer', status: 'removed' },
      ],
    },
  }
  try {
    mount('/b/settings/recipes?run=brief-wfrun-1')
    const sheet = await screen.findByRole('dialog', { name: /Run: / })
    const warning = await within(sheet).findByRole('list', { name: 'Agents that changed' })
    expect(warning.getAttribute('data-protected')).toBe('block')
    expect(warning.textContent).toContain('builder was replaced since this run started')
    expect(warning.textContent).toContain('reviewer was removed since this run started')
    expect(await within(sheet).findByRole('button', { name: 'Pause' })).toBeTruthy()
  } finally {
    fixtures['/api/workflow-runs/wfrun-1'] = original
  }
})

test('a run that is not there says so, and an empty ?run= is just the library', async () => {
  mount('/b/settings/recipes?run=brief-gone')
  expect(await screen.findByText('That run isn’t available.')).toBeTruthy()
  cleanup()
  mount('/b/settings/recipes?run=')
  await screen.findByRole('listitem', { name: 'Release notes' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a + between two layers adds a step on that connection, and the draft is saved with it', async () => {
  mount()
  await screen.findByRole('button', { name: /Gate Approve the draft/ })
  const before = document.querySelectorAll('[data-node]').length
  fireEvent.click(await screen.findByRole('button', { name: 'Add a step after Approve the draft' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add a gate' }))
  await waitFor(() => expect(document.querySelectorAll('[data-node]').length).toBe(before + 1))
  // The new gate sits between the approval and the branch: approve → gate → branch.
  const added = document.querySelector<HTMLElement>('[data-kind="gate"][data-node="gate1"]')!
  expect(added).toBeTruthy()
  const cards = [...document.querySelectorAll<HTMLElement>('.rl-card[data-node]')].map(
    (card) => card.dataset.node,
  )
  expect(cards.indexOf('gate1')).toBe(cards.indexOf('approve') + 1)
  expect(cards.indexOf('gate1')).toBe(cards.indexOf('passed') - 1)
  await waitFor(() => expect(saveButton()).toBeTruthy())
  // The new card is selected, and its settings are in the panel.
  expect(
    within(screen.getByRole('complementary', { name: 'Selected step' })).getByRole('heading', {
      name: 'Check with me',
    }),
  ).toBeTruthy()
})

test('Add a step after, in the settings, connects the new step after the selected one', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Agent step Review the draft/ }))
  const inspector = screen.getByRole('complementary', { name: 'Selected step' })
  expect(within(inspector).getByText('Runs after step 1')).toBeTruthy()
  fireEvent.click(within(inspector).getByRole('button', { name: 'Add a step after' }))
  fireEvent.click(
    await within(inspector).findByRole('menuitem', { name: 'Add an agent step for builder' }),
  )
  expect(
    await screen.findByRole('button', { name: /Agent step builder step, builder/ }),
  ).toBeTruthy()
  // The new step is selected and runs after the one that was selected.
  expect(within(inspector).getByText(/Runs after step 2/)).toBeTruthy()
})

test('Run opens Start a job with this recipe, and a saved version can be viewed read-only', async () => {
  const router = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'More' }))
  fireEvent.change(await screen.findByLabelText('View a saved version (read-only)'), {
    target: { value: '1' },
  })
  expect(await screen.findByText('Version 1 (read-only)')).toBeTruthy()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Edit a copy of version 1' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to my draft' }))
  fireEvent.click(await screen.findByRole('button', { name: 'More' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run…' }))
  await waitFor(() => expect(router.state.location.search).toBe('?start=job&recipe=wf-release'))
})

// ---- The graph editor (ported from the classic workflow editor's tests)

test('problems are one line under the header, with a way to the step, and every problem shows on its step', async () => {
  mount('/b/settings/recipes/wf-draft')
  const line = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('.bold-rp-problem')
    if (!found) throw new Error('no problem line yet')
    return found
  })
  // One line: how many, and the first one; the big problem boxes are gone.
  expect(line.textContent).toMatch(/^\d+ things? to fix before saving:/)
  expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull()
  // The node carries a flag and its label says how many problems it has.
  expect(
    await screen.findByRole('button', { name: /Agent step Build it, reviewer, 1 problem/ }),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: /Agent step Fix it, builder, 1 problem/ })).toBeTruthy()
  // Save is blocked while there are problems.
  expect(
    (screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement).disabled,
  ).toBe(true)
  // Show it selects a step; its settings carry that step's own problem.
  fireEvent.click(within(line).getByRole('button', { name: 'Show it' }))
  const inspector = screen.getByRole('complementary', { name: 'Selected step' })
  expect(within(inspector).getAllByText('Problem').length).toBeGreaterThan(0)
  // Every step shows its own problems in its settings.
  fireEvent.click(screen.getByRole('button', { name: /Agent step Build it, reviewer, 1 problem/ }))
  expect(
    within(inspector).getAllByText(/nothing is connected to "when it fails"/).length,
  ).toBeGreaterThan(0)
})

test('Show all lists every problem, each with its Show it; Hide folds the list', async () => {
  mount('/b/settings/recipes/wf-draft')
  const line = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('.bold-rp-problem')
    if (!found) throw new Error('no problem line yet')
    return found
  })
  const count = Number(/^(\d+)/.exec(line.textContent ?? '')?.[1])
  expect(count).toBeGreaterThan(1)
  expect(within(line).queryByRole('list', { name: 'All problems' })).toBeNull()
  fireEvent.click(within(line).getByRole('button', { name: 'Show all' }))
  const list = within(line).getByRole('list', { name: 'All problems' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(count)
  fireEvent.click(within(list).getAllByRole('button', { name: 'Show it' })[0]!)
  expect(screen.getByRole('complementary', { name: 'Selected step' })).toBeTruthy()
  fireEvent.click(within(line).getByRole('button', { name: 'Hide' }))
  expect(within(line).queryByRole('list', { name: 'All problems' })).toBeNull()
})

test('typing {{ in an instruction offers the inputs and the earlier steps, and Enter inserts the choice', async () => {
  mount('/b/settings/recipes/wf-release')
  const canvasNode = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  fireEvent.click(canvasNode)
  const field = (await screen.findByRole('combobox', {
    name: 'Instruction',
  })) as HTMLTextAreaElement
  fireEvent.change(field, { target: { value: 'Check {{', selectionStart: 8 } })
  field.setSelectionRange(8, 8)
  fireEvent.change(field, { target: { value: 'Check {{', selectionStart: 8 } })
  const list = await screen.findByRole('listbox', { name: /Values for Instruction/ })
  const labels = within(list)
    .getAllByRole('option')
    .map((o) => o.querySelector('code')?.textContent)
  expect(labels).toEqual(['inputs.topic', 'nodes.draft.output', 'nodes.draft.verdict'])
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(field.value).toBe('Check {{nodes.draft.output}}')
})

test('saving on top of a version someone else saved is explained, keeps the draft and offers a reload', async () => {
  post = (url) =>
    url === '/api/workflows/wf-release/versions'
      ? json({ error: { code: 'conflict', message: 'stale', details: { latestVersion: 2 } } }, 409)
      : undefined
  mount('/b/settings/recipes/wf-release')
  const name = (await screen.findByRole('textbox', { name: 'Recipe name' })) as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Release notes v2' } })
  const save = screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  const alert = await screen.findByRole('alert', { name: 'Someone saved first' })
  expect(
    within(alert).getByText(/Version 2 was saved while you were editing version 1/),
  ).toBeTruthy()
  expect(name.value).toBe('Release notes v2')
  const sent = requests.find((r) => r.url === '/api/workflows/wf-release/versions')!
  expect(JSON.parse(String(sent.init?.body)).baseVersion).toBe(1)
  expect(within(alert).getByRole('button', { name: /Reload version 2/ })).toBeTruthy()
})

test('the outline is the graph as text, and the inspector connects with a select (the keyboard way)', async () => {
  mount('/b/settings/recipes/wf-release')
  const outline = await screen.findByRole('region', { name: 'Outline' })
  expect(within(outline).getByText('when done goes to Review the draft')).toBeTruthy()
  expect(within(outline).getByText('otherwise goes to Repair the draft')).toBeTruthy()
  fireEvent.click(within(outline).getAllByRole('button', { name: 'Published' })[0]!)
  const inspector = screen.getByRole('complementary', { name: 'Selected step' })
  expect(within(inspector).getByRole('heading', { name: 'Published' })).toBeTruthy()
  fireEvent.click(within(outline).getAllByRole('button', { name: 'Draft the notes' })[0]!)
  const connect = within(inspector).getByRole('combobox', {
    name: 'Connect Draft the notes (when it fails) to',
  })
  fireEvent.change(connect, { target: { value: 'repair' } })
  expect(within(inspector).getByText('goes to Repair the draft')).toBeTruthy()
  // Connecting a failure sets "route a failure" for the step, so the choice stays explicit.
  expect(
    (within(inspector).getByRole('radio', { name: /Route a failure/ }) as HTMLInputElement).checked,
  ).toBe(true)
})

// ---- The layered view (PLAN 3.26.0). The free canvas is gone; stored positions are kept but never drawn from.

const withStoredLayout = () => {
  const drawn = structuredClone(workflowFixtures['/api/workflows/wf-release']) as {
    latest: { definition: { layout?: unknown } }
  }
  drawn.latest.definition.layout = {
    nodes: { draft: { x: 640, y: 480 }, review: { x: 16, y: 16 }, publish: { x: 320, y: 160 } },
  }
  const original = workflowFixtures['/api/workflows/wf-release']
  workflowFixtures['/api/workflows/wf-release'] = drawn
  dispose.push(() => {
    workflowFixtures['/api/workflows/wf-release'] = original
  })
}

test('the cards read top to bottom by rank, whatever positions were saved; parallel steps sit side by side', async () => {
  withStoredLayout()
  mount('/b/settings/recipes/wf-release')
  await screen.findByRole('button', { name: /Agent step Draft the notes/ })
  const order = [...document.querySelectorAll<HTMLElement>('.rl-card[data-node]')].map(
    (card) => card.dataset.node,
  )
  expect(order).toEqual(['draft', 'review', 'approve', 'passed', 'publish', 'repair', 'repaired'])
  // publish and repair are one layer: one row, "at the same time".
  const row = document.querySelector('.rl-row')!
  expect(
    [...row.querySelectorAll('[data-node]')].map((card) => (card as HTMLElement).dataset.node),
  ).toEqual(['publish', 'repair'])
  expect(screen.getByText('at the same time')).toBeTruthy()
  // The free canvas's controls are gone.
  expect(screen.queryByRole('button', { name: 'Arrange automatically' })).toBeNull()
  expect(screen.queryByRole('region', { name: 'Palette' })).toBeNull()
})

test('saving keeps the stored positions as they were', async () => {
  withStoredLayout()
  post = (url) =>
    url === '/api/workflows/wf-release/versions'
      ? json({ error: { code: 'conflict', message: 'stale', details: { latestVersion: 2 } } }, 409)
      : undefined
  mount('/b/settings/recipes/wf-release')
  const name = (await screen.findByRole('textbox', { name: 'Recipe name' })) as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Release notes v2' } })
  const save = screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  await screen.findByRole('alert', { name: 'Someone saved first' })
  const sent = JSON.parse(
    String(requests.find((r) => r.url === '/api/workflows/wf-release/versions')!.init?.body),
  ) as {
    definition: { layout: { nodes: Record<string, { x: number; y: number }> }; nodes: unknown[] }
  }
  expect(sent.definition.layout.nodes).toEqual({
    draft: { x: 640, y: 480 },
    review: { x: 16, y: 16 },
    publish: { x: 320, y: 160 },
  })
  expect(sent.definition.nodes).toEqual(releaseDefinition.nodes)
})

test('Delete on a selected card asks first; a no keeps the step, a yes removes it and its saved position', async () => {
  withStoredLayout()
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
  fireEvent.keyDown(card, { key: 'Delete' })
  expect(ask).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: /Agent step Review the draft/ })).toBeTruthy()
  expect(screen.queryByText(/unsaved changes/)).toBeNull()
  ask.mockReturnValue(true)
  fireEvent.keyDown(card, { key: 'Backspace' })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Agent step Review the draft/ })).toBeNull(),
  )
  expect(screen.getByText(/unsaved changes/)).toBeTruthy()
  // Undo brings it back.
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(await screen.findByRole('button', { name: /Agent step Review the draft/ })).toBeTruthy()
})

test('the step settings sit to the right of the recipe in both Graph and As text, never below the list', async () => {
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Gate Approve the draft/ })
  fireEvent.click(card)
  const beside = () => {
    const body = document.querySelector('.bold-rp-body')!
    // The recipe first, the settings after it, in the same row: not under the list.
    expect([...body.children].map((child) => child.getAttribute('aria-label'))).toEqual([
      'The recipe',
      'Selected step',
    ])
    expect(body.querySelector('[aria-label="The recipe"] [aria-label="Selected step"]')).toBeNull()
  }
  beside()
  const steps = await showText()
  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  beside()
  const panel = screen.getByRole('complementary', { name: 'Selected step' })
  expect(within(panel).getByRole('textbox', { name: 'Title' })).toBeTruthy()
  expect(steps.closest('.bold-rp-body')).toBe(panel.closest('.bold-rp-body'))
})

test('a card is a button: Enter or a click selects it, and the settings open beside it', async () => {
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Gate Approve the draft/ })
  expect(card.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(card)
  expect(card.getAttribute('aria-pressed')).toBe('true')
  expect(
    within(screen.getByRole('complementary', { name: 'Selected step' })).getByRole('heading', {
      name: 'Approve the draft',
    }),
  ).toBeTruthy()
})

test('on a phone the step settings are a sheet that closes with its button', async () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('width < 600px') || query.includes('width <= 860px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  // Nothing selected: no panel, the graph has the page.
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
  fireEvent.click(card)
  const sheet = screen.getByRole('complementary', { name: 'Selected step' })
  expect(sheet.className).toContain('bold-rp-sheet')
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close step settings' }))
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
})

test('on a tablet (600 to 860px) the step settings are a bottom sheet too, in both views, not a block under the recipe', async () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('width <= 860px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
  fireEvent.click(card)
  expect(screen.getByRole('complementary', { name: 'Selected step' }).className).toContain(
    'bold-rp-sheet',
  )
  const steps = await showText()
  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  expect(screen.getByRole('complementary', { name: 'Selected step' }).className).toContain(
    'bold-rp-sheet',
  )
})

test('on a phone the step settings are a bottom sheet in As text too, opening when a step is chosen', async () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('width < 600px') || query.includes('width <= 860px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  mount('/b/settings/recipes/wf-release')
  const steps = await showText()
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  const sheet = screen.getByRole('complementary', { name: 'Selected step' })
  expect(sheet.className).toContain('bold-rp-sheet')
  expect(within(sheet).getByRole('textbox', { name: 'Title' })).toBeTruthy()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close step settings' }))
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
})

test('the editor draws a run of the version on screen over the cards, and links to it', async () => {
  mount('/b/settings/recipes/wf-release')
  const live = await screen.findByText(/Live: run started/)
  expect(
    within(live.closest('p')!)
      .getByRole('link', { name: /Open the run/ })
      .getAttribute('href'),
  ).toBe('/b?run=brief-wfrun-1')
  // The gate of the running run waits for you; the steps before it are done. The draft is untouched.
  expect(
    await screen.findByRole('button', { name: /Gate Approve the draft.*needs you/ }),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: /Agent step Draft the notes.*succeeded/ })).toBeTruthy()
  expect(screen.queryByText(/unsaved changes/)).toBeNull()
})

test('Preview plays the drawn workflow, says nothing runs, and Stop returns to the cards', async () => {
  mount('/b/settings/recipes/wf-release')
  const preview = (await screen.findByRole('button', {
    name: 'Preview, nothing runs',
  })) as HTMLButtonElement
  await waitFor(() => expect(preview.disabled).toBe(false))
  fireEvent.click(preview)
  expect(screen.getByText('Preview: nothing runs, no tokens')).toBeTruthy()
  expect(screen.queryByText(/Live: run started/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(await screen.findByRole('button', { name: /Agent step Draft the notes/ })).toBeTruthy()
  // Nothing was sent to the server for the preview.
  expect(requests.filter((r) => r.init?.method === 'POST' && !r.url.endsWith('/validate'))).toEqual(
    [],
  )
})

test('Preview is disabled while the draft has problems, and says why', async () => {
  mount('/b/settings/recipes/wf-draft')
  const preview = (await screen.findByRole('button', {
    name: 'Preview, nothing runs',
  })) as HTMLButtonElement
  await waitFor(() => expect(preview.disabled).toBe(true))
  expect(preview.title).toMatch(/Fix the problems first/)
  expect(preview.getAttribute('aria-describedby')).toBeTruthy()
})

test('a recipe with runs can be archived, and an archived one is hidden until Archived is shown', async () => {
  const summary = { ...releaseDetail, used: true, archivedAt: null as string | null }
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [summary],
  }
  post = (url) => {
    if (url === '/api/workflows/wf-release/archive') {
      summary.archivedAt = '2026-10-27T00:00:00.000Z'
      return json(summary)
    }
    if (url === '/api/workflows/wf-release/unarchive') {
      summary.archivedAt = null
      return json(summary)
    }
    return undefined
  }
  try {
    mount('/b/settings/recipes/wf-release')
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    // Delete recipe is for a recipe nothing has run; this one has runs.
    expect(screen.queryByRole('button', { name: 'Delete recipe' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(await screen.findByText(/Archived: this recipe is hidden/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => expect(screen.queryByText(/Archived: this recipe is hidden/)).toBeNull())
  } finally {
    fixtures['/api/workflows'] = original
  }
})

test('Delete with runs asks for the recipe name and says it can not be undone', async () => {
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [{ ...releaseDetail, used: true, archivedAt: null }],
  }
  let body: unknown
  post = (url, init) => {
    if (url !== '/api/workflows/wf-release/delete-with-runs') return undefined
    body = JSON.parse(String(init?.body))
    return json({ deletedRuns: 2 })
  }
  try {
    const router = mount('/b/settings/recipes/wf-release')
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete with runs…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete recipe with its runs' })
    expect(dialog.getAttribute('data-protected')).toBe('flex')
    expect(dialog.textContent).toContain('can’t be undone')
    const confirm = within(dialog).getByRole('button', {
      name: 'Delete recipe and runs',
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/Type the recipe/), {
      target: { value: releaseDetail.name },
    })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(body).toEqual({ confirm: releaseDetail.name }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
    // The library says what happened.
    expect((await screen.findByText('Deleted the recipe.')).getAttribute('role')).toBe('status')
    // The history entry no longer carries it, so a reload or a later visit doesn't repeat it (3.29.0 review).
    await waitFor(() => expect(router.state.location.state).toBeNull())
    expect(screen.getByText('Deleted the recipe.')).toBeDefined()
  } finally {
    fixtures['/api/workflows'] = original
  }
})

test('the delete-with-runs dialog takes focus, Escape cancels, and focus returns to More', async () => {
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [{ ...releaseDetail, used: true, archivedAt: null }],
  }
  try {
    mount('/b/settings/recipes/wf-release')
    const more = await screen.findByRole('button', { name: 'More' })
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('button', { name: 'Delete with runs…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete recipe with its runs' })
    const field = within(dialog).getByLabelText(/Type the recipe/)
    await waitFor(() => expect(document.activeElement).toBe(field))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(more)
  } finally {
    fixtures['/api/workflows'] = original
  }
})

// The run links (`?run=`) now land on the Recipes page, so the page itself must show a run's list rather than the recipes.

const phoneMedia = () =>
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('width < 600px') || query.includes('width <= 860px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )

test('deleting a middle step joins the step before to the step after, says so, and focuses the joined card', async () => {
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  fireEvent.keyDown(card, { key: 'Delete' })
  expect(await screen.findByText(/Joined .* to Approve the draft\./)).toBeTruthy()
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Gate Approve the draft/ }),
    ),
  )
  // One undo brings back the step and its connections together.
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(await screen.findByRole('button', { name: /Agent step Review the draft/ })).toBeTruthy()
})

test('after an insert, focus goes to the new card', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add a step after Approve the draft' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add a gate' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector('.rl-card[data-node="gate1"]')),
  )
})

test('phone sheet: compact with the instruction, focus moves in and back, Escape closes it from anywhere, More settings expands it', async () => {
  phoneMedia()
  mount('/b/settings/recipes/wf-release')
  const card = await screen.findByRole('button', { name: /Agent step Review the draft/ })
  fireEvent.click(card)
  const sheet = screen.getByRole('complementary', { name: 'Selected step' })
  await waitFor(() => expect(document.activeElement).toBe(sheet))
  expect(within(sheet).getByRole('heading', { name: 'Review the draft' })).toBeTruthy()
  expect(within(sheet).getByRole('combobox', { name: 'Instruction' })).toBeTruthy()
  expect(within(sheet).getByRole('button', { name: 'Delete step' })).toBeTruthy()
  // Compact: the title field and the retries live behind "More settings".
  expect(within(sheet).queryByRole('textbox', { name: 'Title' })).toBeNull()
  fireEvent.click(within(sheet).getByRole('button', { name: 'More settings' }))
  expect(within(sheet).getByRole('textbox', { name: 'Title' })).toBeTruthy()
  expect(within(sheet).getByRole('button', { name: 'Fewer settings' })).toBeTruthy()
  // Escape closes it even when focus is back on a card, and the card has focus afterwards.
  const other = screen.getByRole('button', { name: /Gate Approve the draft/ })
  other.focus()
  fireEvent.keyDown(other, { key: 'Escape' })
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Agent step Review the draft/ }),
    ),
  )
})

test('phone sheet: Delete step removes the step with its join, and an insert keeps focus on the new card', async () => {
  phoneMedia()
  mount('/b/settings/recipes/wf-release')
  fireEvent.click(await screen.findByRole('button', { name: /Agent step Review the draft/ }))
  const sheet = screen.getByRole('complementary', { name: 'Selected step' })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Delete step' }))
  expect(screen.queryByRole('button', { name: /Agent step Review the draft/ })).toBeNull()
  expect(screen.queryByRole('complementary', { name: 'Selected step' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add a step after Approve the draft' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add a gate' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector('.rl-card[data-node="gate1"]')),
  )
})

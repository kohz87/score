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
  // What only the classic list showed, a recipe's run status, sits in the editor.
  const status = await within(dialog).findByLabelText('Runs of this recipe')
  expect(status.textContent).toContain('1 run going')
  expect(within(status).getByRole('link', { name: 'Running' }).getAttribute('href')).toMatch(
    /^\/b\/settings\/recipes\?run=brief-/,
  )
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

test('a dirty draft asks before leaving for another recipe', async () => {
  const router = mount()
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Changed' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

  fireEvent.click(screen.getByRole('button', { name: /lead decides/ }))
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?'),
  )
  expect(router.state.location.pathname).toBe('/b/settings/recipes/wf-release')

  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: /lead decides/ }))
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/b/settings/recipes/lead-decides'),
  )
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

test('the page lists the built-in recipe and the saved ones, and opens on the graph', async () => {
  mount('/b/settings/recipes')
  const list = await screen.findByRole('navigation', { name: 'Recipes' })
  expect(within(list).getByRole('button', { name: /lead decides/ })).toBeTruthy()
  expect(within(list).getByText('Built in')).toBeTruthy()
  expect(
    (await within(list).findAllByRole('button', { name: /Version 1/ })).length,
  ).toBeGreaterThan(0)
  // The first saved recipe is open, drawn as a graph with its own step settings beside it.
  expect(await screen.findByRole('tab', { name: 'Graph', selected: true })).toBeTruthy()
  expect(document.querySelector('[data-node]')).not.toBeNull()
  expect(screen.getByRole('complementary', { name: 'Selected step' })).toBeTruthy()
})

test('the list is searchable and lead decides is a page with a way to start a job', async () => {
  const router = mount('/b/settings/recipes/lead-decides')
  expect(await screen.findByRole('heading', { name: 'lead decides' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Start a job' }).getAttribute('href')).toBe(
    '/b?start=job',
  )
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a recipe' }), {
    target: { value: 'zzz' },
  })
  expect(await screen.findByText('No recipe matches “zzz”.')).toBeTruthy()
  expect(router.state.location.pathname).toBe('/b/settings/recipes/lead-decides')
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
  fireEvent.click(await screen.findByRole('button', { name: 'Run…' }))
  await waitFor(() => expect(router.state.location.search).toBe('?start=job&recipe=wf-release'))
})

// ---- The graph editor (ported from the classic workflow editor's tests)

test('the editor shows every server problem on the node it is about, with words for what to do', async () => {
  mount('/b/settings/recipes/wf-draft')
  const problems = await screen.findByRole('region', { name: 'Problems' })
  await within(problems).findAllByText(/nothing is connected to "when it fails"/)
  expect(within(problems).getByText(/The workflow has no end/)).toBeTruthy()
  expect(
    within(problems).getAllByText(/Connect it, or choose|Add an End node/).length,
  ).toBeGreaterThan(0)
  // The node carries a flag and its label says how many problems it has.
  expect(
    screen.getByRole('button', { name: /Agent step Build it, reviewer, 1 problem/ }),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: /Agent step Fix it, builder, 1 problem/ })).toBeTruthy()
  // Save is blocked while there are problems.
  expect(
    (screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement).disabled,
  ).toBe(true)
  // Selecting the node shows the same problem in the inspector.
  fireEvent.click(within(problems).getAllByRole('button', { name: 'Build it' })[0]!)
  const inspector = screen.getByRole('complementary', { name: 'Selected step' })
  expect(
    within(inspector).getAllByText(/nothing is connected to "when it fails"/).length,
  ).toBeGreaterThan(0)
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
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(await screen.findByRole('button', { name: /Agent step Review the draft/ })).toBeTruthy()
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
        matches: query.includes('width < 600px'),
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

test('the editor draws a run of the version on screen over the cards, and links to it', async () => {
  mount('/b/settings/recipes/wf-release')
  const live = await screen.findByText(/Live: run started/)
  expect(
    within(live.closest('p')!)
      .getByRole('link', { name: /Open the run/ })
      .getAttribute('href'),
  ).toBe('/b/settings/recipes?run=brief-wfrun-1')
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
  await screen.findByRole('region', { name: 'Problems' })
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
test('/b/settings/recipes?run= shows the list of runs instead of the recipes', async () => {
  mount('/b/settings/recipes?run=')
  expect(await screen.findByRole('list', { name: 'Runs' })).toBeDefined()
  expect(screen.queryByRole('navigation', { name: 'Recipes' })).toBeNull()
})

const phoneMedia = () =>
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('width < 600px'),
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

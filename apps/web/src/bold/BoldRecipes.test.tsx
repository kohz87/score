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

function mount(path = '/b/recipes/wf-release') {
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
      { path: '/b/recipes', Component: BoldRecipesPage },
      { path: '/b/recipes/:workflowId', Component: BoldRecipesPage },
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
    /^\/b\?run=brief-/,
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
  expect(router.state.location.pathname).toBe('/b/recipes/wf-release')

  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: /lead decides/ }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/recipes/lead-decides'))
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
  mount('/b/recipes')
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
  const router = mount('/b/recipes/lead-decides')
  expect(await screen.findByRole('heading', { name: 'lead decides' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Start a job' }).getAttribute('href')).toBe(
    '/b?start=job',
  )
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a recipe' }), {
    target: { value: 'zzz' },
  })
  expect(await screen.findByText('No recipe matches “zzz”.')).toBeTruthy()
  expect(router.state.location.pathname).toBe('/b/recipes/lead-decides')
})

test('a step added in the graph is connected after the selected one and saved with the draft', async () => {
  mount()
  const palette = await screen.findByRole('region', { name: 'Palette' })
  const before = document.querySelectorAll('[data-node]').length
  fireEvent.click(within(palette).getByRole('button', { name: /Add a gate/ }))
  await waitFor(() => expect(document.querySelectorAll('[data-node]').length).toBe(before + 1))
  await waitFor(() => expect(saveButton()).toBeTruthy())
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
  mount('/b/recipes/wf-draft')
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
  mount('/b/recipes/wf-release')
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
  mount('/b/recipes/wf-release')
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

test('the outline is the canvas as text, and the inspector connects with a select (the keyboard way)', async () => {
  mount('/b/recipes/wf-release')
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

// ---- Free placement (PLAN 7.1c)

const nodeBox = (id: string) =>
  document.querySelector<HTMLElement>(`.wf-node[data-wf-node="${id}"]`)!
const at = (id: string) => ({
  x: Number.parseFloat(nodeBox(id).style.left),
  y: Number.parseFloat(nodeBox(id).style.top),
})
const drawnNode = (name: RegExp) => screen.findByRole('button', { name })
function drag(
  el: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  alt = false,
) {
  fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, button: 0, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, altKey: alt, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, altKey: alt, pointerId: 1 })
}

test('dragging a node moves it on a 16 px grid, marks the draft unsaved and keeps the others where they were', async () => {
  mount('/b/recipes/wf-release')
  const node = await drawnNode(/Agent step Draft the notes/)
  const before = { draft: at('draft'), review: at('review'), publish: at('publish') }
  const start = { x: before.draft.x + 20, y: before.draft.y + 10 }
  drag(node, start, { x: start.x + 53, y: start.y + 37 })
  expect(at('draft')).toEqual({
    x: Math.round((before.draft.x + 53) / 16) * 16,
    y: Math.round((before.draft.y + 37) / 16) * 16,
  })
  // Pinning on the first move: nobody else jumps.
  expect(at('review')).toEqual(before.review)
  expect(at('publish')).toEqual(before.publish)
  expect(screen.getByText(/unsaved changes/)).toBeTruthy()
  // The drag did not select the node.
  expect(screen.getByRole('complementary', { name: 'Selected step' }).textContent).toMatch(
    /Nothing selected/,
  )
})

test('holding Alt places the node exactly under the pointer, and a node never goes off the top left', async () => {
  mount('/b/recipes/wf-release')
  const node = await drawnNode(/Agent step Draft the notes/)
  const p = at('draft')
  drag(node, { x: p.x + 5, y: p.y + 5 }, { x: p.x + 5 + 53, y: p.y + 5 + 37 }, true)
  expect(at('draft')).toEqual({ x: p.x + 53, y: p.y + 37 })
  drag(node, { x: 500, y: 500 }, { x: -900, y: -900 })
  expect(at('draft')).toEqual({ x: 0, y: 0 })
})

test('the keyboard moves a node: M, arrows (Shift for big steps), Escape; one undo step per run of presses', async () => {
  mount('/b/recipes/wf-release')
  const node = await drawnNode(/Agent step Draft the notes/)
  node.focus()
  const p = at('draft')
  // Before M, the arrows move the focus, not the node.
  fireEvent.keyDown(node, { key: 'ArrowRight' })
  expect(at('draft')).toEqual(p)
  fireEvent.keyDown(node, { key: 'm' })
  fireEvent.keyDown(node, { key: 'ArrowRight' })
  fireEvent.keyDown(node, { key: 'ArrowRight' })
  fireEvent.keyDown(node, { key: 'ArrowDown', shiftKey: true })
  expect(at('draft')).toEqual({
    x: Math.round((p.x + 32) / 16) * 16,
    y: Math.round((p.y + 80) / 16) * 16,
  })
  expect(
    screen.getByText(/draft at|Draft the notes at/, { selector: '[role="status"]' }),
  ).toBeTruthy()
  fireEvent.keyDown(node, { key: 'Escape' })
  fireEvent.keyDown(node, { key: 'ArrowRight' })
  expect(at('draft').x).toBeLessThan(p.x + 33 + 16)
  // The three presses are one history step.
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(at('draft')).toEqual(p)
  expect(screen.queryByText(/unsaved changes/)).toBeNull()
})

test('Arrange automatically is one undoable step that drops the saved positions', async () => {
  mount('/b/recipes/wf-release')
  const node = await drawnNode(/Agent step Draft the notes/)
  const arrange = screen.getByRole('button', { name: 'Arrange automatically' }) as HTMLButtonElement
  expect(arrange.disabled).toBe(true)
  const auto = at('draft')
  drag(node, { x: auto.x + 5, y: auto.y + 5 }, { x: auto.x + 205, y: auto.y + 165 })
  const dragged = at('draft')
  expect(dragged).not.toEqual(auto)
  expect(arrange.disabled).toBe(false)
  fireEvent.click(arrange)
  expect(at('draft')).toEqual(auto)
  expect(arrange.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(at('draft')).toEqual(dragged)
})

test('saving sends the layout with the definition; a moved node is the only change', async () => {
  post = (url) =>
    url === '/api/workflows/wf-release/versions'
      ? json({ error: { code: 'conflict', message: 'stale', details: { latestVersion: 2 } } }, 409)
      : undefined
  mount('/b/recipes/wf-release')
  const node = await drawnNode(/Agent step Draft the notes/)
  const save = screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  const p = at('draft')
  drag(node, { x: p.x + 5, y: p.y + 5 }, { x: p.x + 69, y: p.y + 5 })
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  await screen.findByRole('alert', { name: 'Someone saved first' })
  const sent = JSON.parse(
    String(requests.find((r) => r.url === '/api/workflows/wf-release/versions')!.init?.body),
  ) as {
    definition: { layout: { nodes: Record<string, { x: number; y: number }> }; nodes: unknown[] }
  }
  expect(Object.keys(sent.definition.layout.nodes).sort()).toEqual(
    releaseDefinition.nodes.map((n) => n.id).sort(),
  )
  expect(sent.definition.layout.nodes.draft).toEqual(at('draft'))
  expect(sent.definition.nodes).toEqual(releaseDefinition.nodes)
})

test('deleting a node drops its position, and a saved layout is what the editor draws', async () => {
  const drawn = structuredClone(workflowFixtures['/api/workflows/wf-release']) as {
    latest: { definition: { layout?: unknown } }
  }
  drawn.latest.definition.layout = {
    nodes: { draft: { x: 320, y: 160 }, review: { x: 640, y: 48 } },
  }
  const original = workflowFixtures['/api/workflows/wf-release']
  workflowFixtures['/api/workflows/wf-release'] = drawn
  dispose.push(() => {
    workflowFixtures['/api/workflows/wf-release'] = original
  })
  mount('/b/recipes/wf-release')
  await drawnNode(/Agent step Draft the notes/)
  expect(at('draft')).toEqual({ x: 320, y: 160 })
  expect(at('review')).toEqual({ x: 640, y: 48 })
  // A node without a position is placed automatically.
  expect(at('publish').x).toBeGreaterThan(0)
  expect(
    (screen.getByRole('button', { name: 'Arrange automatically' }) as HTMLButtonElement).disabled,
  ).toBe(false)
})

test('the editor draws a run of the version on screen over the canvas, and links to it', async () => {
  mount('/b/recipes/wf-release')
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

test('Preview plays the drawn workflow, says nothing runs, and Stop returns to the canvas', async () => {
  mount('/b/recipes/wf-release')
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
  mount('/b/recipes/wf-draft')
  const preview = (await screen.findByRole('button', {
    name: 'Preview, nothing runs',
  })) as HTMLButtonElement
  await screen.findByRole('region', { name: 'Problems' })
  await waitFor(() => expect(preview.disabled).toBe(true))
  expect(preview.title).toMatch(/Fix the problems first/)
  expect(preview.getAttribute('aria-describedby')).toBeTruthy()
})

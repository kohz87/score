// Recipe library cards and the read-only run sheet.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { workflowFixtures } from '../../../../e2e/workflow-fixtures.ts'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { json, mount, requests } = setUpRecipeTests()

test('Recipes is a library of cards: the built-in one first, no editor open, each card with what it does and its links', async () => {
  const router = mount('/b/tasks/recipes')
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
    '/b/tasks/recipes/wf-release',
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
  mount('/b/tasks/recipes')
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
  const router = mount('/b/tasks/recipes')
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
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/tasks/recipes/new'))
  expect(await screen.findByDisplayValue('Untitled recipe')).toBeTruthy()
  expect(screen.getByRole('link', { name: '‹ Recipes' }).getAttribute('href')).toBe(
    '/b/tasks/recipes',
  )

  cleanup()
  mount('/b/tasks/recipes/lead-decides')
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
  mount('/b/tasks/recipes')
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
  const router = mount('/b/tasks/recipes?run=brief-wfrun-1')
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
  const router = mount('/b/tasks/recipes?run=brief-wfrun-1')
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
    mount('/b/tasks/recipes?run=brief-wfrun-1')
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
  mount('/b/tasks/recipes?run=brief-gone')
  expect(await screen.findByText('That run isn’t available.')).toBeTruthy()
  cleanup()
  mount('/b/tasks/recipes?run=')
  await screen.findByRole('listitem', { name: 'Release notes' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

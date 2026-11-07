// ---- The layered view (PLAN 3.26.0). The free canvas is gone; stored positions are kept but never drawn from.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { releaseDefinition } from '../../../../e2e/workflow-fixtures.ts'
import { setUpRecipeTests, type PostHandler } from './BoldRecipes-helpers.tsx'

let post: PostHandler
const { json, mount, requests, showText, withStoredLayout } = setUpRecipeTests({
  getPost: () => post,
  resetPost: () => {
    post = () => undefined
  },
})

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

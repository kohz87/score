// Recipe run overlay and preview in the editor.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { mount, requests } = setUpRecipeTests()

test('the editor draws a run of the version on screen over the cards, and links to it', async () => {
  mount('/b/tasks/recipes/wf-release')
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
  mount('/b/tasks/recipes/wf-release')
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
  mount('/b/tasks/recipes/wf-draft')
  const preview = (await screen.findByRole('button', {
    name: 'Preview, nothing runs',
  })) as HTMLButtonElement
  await waitFor(() => expect(preview.disabled).toBe(true))
  expect(preview.title).toMatch(/Fix the problems first/)
  expect(preview.getAttribute('aria-describedby')).toBeTruthy()
})

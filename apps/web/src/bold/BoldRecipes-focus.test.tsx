// Keyboard focus after graph edits, and the phone step-sheet focus.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { mount, phoneMedia } = setUpRecipeTests()

test('deleting a middle step joins the step before to the step after, says so, and focuses the joined card', async () => {
  mount('/b/tasks/recipes/wf-release')
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
  mount('/b/tasks/recipes/wf-release')
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
  mount('/b/tasks/recipes/wf-release')
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

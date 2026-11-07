// ---- The graph editor (ported from the classic workflow editor's tests)
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { mount, saveButton } = setUpRecipeTests()

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

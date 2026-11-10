import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { uniqueRecipeName } from './recipe-run.ts'
import {
  chooseStep,
  createViaApi,
  inspector,
  openMore,
  openRecipes,
  openRecipeText,
  steps,
  workflowDetail,
  workflows,
} from './bold-recipes-helpers.ts'

test('moving and removing steps re-links the saved graph', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = uniqueRecipeName('Order')
  const id = await createViaApi(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'One',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'two',
        kind: 'agent',
        label: 'Two',
        agentId: 'builder',
        instruction: 'Two',
        retries: 0,
        onFailure: 'fail_run',
      },
      {
        id: 'three',
        kind: 'agent',
        label: 'Three',
        agentId: 'builder',
        instruction: 'Three',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'one', port: 'ok', to: 'two' },
      { id: 'e2', from: 'two', port: 'ok', to: 'three' },
      { id: 'e3', from: 'three', port: 'ok', to: 'done' },
    ],
  })
  await openRecipeText(page, name)

  await page.getByRole('button', { name: 'Move Two up' }).click()
  await expect(steps(page).locator('.bold-step')).toHaveText([
    /^1.*Two/,
    /^2.*One/,
    /^3.*Three/,
    /^4.*Done/,
  ])
  await expect(page.getByRole('status').filter({ hasText: 'Moved Two to step 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Move Two down' })).toBeFocused()
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })
  const moved = (await workflowDetail(page, id)).latest.definition.edges
  expect(moved).toHaveLength(3)
  expect(moved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: 'two', port: 'ok', to: 'one' }),
      expect.objectContaining({ from: 'one', port: 'ok', to: 'three' }),
      expect.objectContaining({ from: 'three', port: 'ok', to: 'done' }),
    ]),
  )

  await page.getByRole('button', { name: 'Remove One' }).click()
  await expect(steps(page).locator('.bold-step')).toHaveText([/^1.*Two/, /^2.*Three/, /^3.*Done/])
  await expect(page.getByRole('status').filter({ hasText: 'Removed One' })).toBeVisible()
  await expect(page.locator('[data-recipe-step="three"] .bold-step')).toBeFocused()
  await page.getByRole('button', { name: 'Save as version 3' }).click()
  await expect(page.getByText('Saved as version 3.')).toBeVisible({ timeout: 20_000 })
  const removed = (await workflowDetail(page, id)).latest.definition
  expect(removed.nodes.map((node) => node.id)).toEqual(['two', 'three', 'done'])
  expect(removed.edges).toHaveLength(2)
  expect(removed.edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: 'two', port: 'ok', to: 'three' }),
      expect.objectContaining({ from: 'three', port: 'ok', to: 'done' }),
    ]),
  )

  // Decision 183: a step can have its own model and effort; its pills turn amber and the definition carries both.
  await chooseStep(page, 'Two')
  const model = inspector(page).getByRole('combobox', { name: 'Model' })
  await expect.poll(async () => model.locator('option').count()).toBeGreaterThan(1)
  await model.selectOption({ index: 1 })
  await expect(page.locator('[data-recipe-step="two"] .bold-pin--set').first()).toBeVisible()
  await page.getByRole('button', { name: 'Save as version 4' }).click()
  await expect(page.getByText('Saved as version 4.')).toBeVisible({ timeout: 20_000 })
  const pinned = (await workflowDetail(page, id)).latest.definition.nodes as {
    id: string
    model?: { model: string }
  }[]
  expect(pinned.find((node) => node.id === 'two')?.model?.model).toBeTruthy()
  expect(pinned.find((node) => node.id === 'three')?.model).toBeUndefined()
})

test('the graph editor adds, connects and removes steps, keeps keyboard use, and saves what was drawn', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page, 'new')
  await expect(page.getByRole('tab', { name: 'Graph', selected: true })).toBeVisible()
  const name = `Drawn ${Date.now().toString(36)}`
  await page.getByRole('textbox', { name: 'Recipe name' }).fill(name)

  // The starter has one agent step and an end; select the agent step and give it an instruction.
  const nodes = page.locator('[data-node]')
  await expect(nodes).toHaveCount(2)
  await page.locator('[data-node="step1"]').click()
  await inspector(page).getByLabel('Agent').selectOption({ label: 'builder' })
  await inspector(page).getByRole('combobox', { name: 'Instruction' }).fill('Write a short note.')

  // Replace the starter end: delete it from the keyboard (the layered view asks first), then build the route from the
  // selected card's "Add a step after" menu.
  page.on('dialog', (prompt) => void prompt.accept())
  const end = page.locator('[data-node="end1"]')
  await end.focus()
  await page.keyboard.press('Delete')
  await expect(nodes).toHaveCount(1)
  await page.locator('[data-node="step1"]').click()
  await inspector(page).getByRole('button', { name: 'Add a step after', exact: true }).click()
  await page.getByRole('menuitem', { name: /Add a gate/ }).click()
  await expect(nodes).toHaveCount(2)
  await inspector(page).getByRole('combobox', { name: 'Question' }).fill('Publish it?')
  await inspector(page).getByRole('button', { name: 'Add a step after', exact: true }).click()
  await page.getByRole('menuitem', { name: /Add an end/ }).click()
  await expect(nodes).toHaveCount(3)
  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })

  // Undo takes the gate's question away, redo brings it back.
  const more = await openMore(page)
  await more.getByRole('button', { name: 'Undo' }).click()
  await expect(more.getByRole('button', { name: 'Redo' })).toBeEnabled()
  await more.getByRole('button', { name: 'Redo' }).click()

  // A step is deleted from the keyboard; undo returns it.
  const gate = page.locator('[data-kind="gate"]')
  await gate.focus()
  await page.keyboard.press('Delete')
  await expect(nodes).toHaveCount(2)
  await (await openMore(page)).getByRole('button', { name: 'Undo' }).click()
  await expect(nodes).toHaveCount(3)

  // The outline is the graph as text.
  await page.getByText('Outline: the graph as text').click()
  await expect(page.getByRole('region', { name: 'Outline' })).toContainText('when done goes to')

  await expect(page.getByRole('status').filter({ hasText: 'Looks good' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: /^Save as version 1$/ }).click()
  await expect(page.getByText('Saved as version 1.')).toBeVisible({ timeout: 20_000 })
  const saved = (await workflows(page)).find((workflow) => workflow.name === name)!
  const detail = await workflowDetail(page, saved.id)
  expect(detail.latest.definition.nodes).toHaveLength(3)
  expect(detail.latest.definition.edges.length).toBeGreaterThanOrEqual(2)
})

test('a phone shows the library as one column, the recipe full width and the step settings as a bottom sheet', async ({
  page,
}) => {
  await pair(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 3.29.0: the library is a column of cards; the editor has no list above it.
  await page.goto('/b/recipes')
  const cards = page.getByRole('list', { name: 'Recipes', exact: true }).getByRole('listitem')
  await expect(cards.first()).toBeVisible()
  const first = await cards.first().boundingBox()
  expect(first!.x + first!.width).toBeLessThanOrEqual(390)
  await openRecipes(page, 'new')
  await expect(page.getByRole('navigation', { name: 'Recipes' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '‹ Recipes' })).toBeVisible()
  const main = await page.getByRole('region', { name: 'Recipe editor' }).boundingBox()
  expect(main!.x + main!.width).toBeLessThanOrEqual(390)
  // The step's settings are a sheet from the bottom, only while a card is selected.
  await expect(inspector(page)).toHaveCount(0)
  await page.locator('[data-node="step1"]').click()
  await expect(inspector(page)).toBeVisible()
  const panel = await inspector(page).boundingBox()
  expect(panel!.x).toBeGreaterThanOrEqual(0)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390)
  expect(panel!.y + panel!.height).toBeGreaterThan(844 - 2)
  await page.getByRole('button', { name: 'Close step settings' }).click()
  await expect(inspector(page)).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0)
  await expect(page.getByRole('button', { name: /^Save as version \d+$/u })).toBeVisible()
})

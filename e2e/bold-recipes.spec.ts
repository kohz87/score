import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import {
  chooseStep,
  createViaApi,
  inspector,
  openDetails,
  openMore,
  openRecipes,
  openRecipeText,
  showText,
  step,
  web,
  workflowDetail,
  workflows,
} from './bold-recipes-helpers.ts'

// PLAN 11.10d, as the Recipes page since 2.8.0, against the fake adapter. A recipe is the 7.1 workflow definition, so every edit here goes through the
// same API and engine; no model is called. Instruction markers script the fake agents: [fake:verdict:passed] replies
// with a passed verdict and [fake:fail] ends that step's attempt failed.

test('conflict, older version, scrubbed export and delete', async ({ page }) => {
  test.setTimeout(150_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = `Versions ${Date.now().toString(36)}`
  const id = await createViaApi(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'Do it',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
  })
  await openRecipeText(page, name)
  await chooseStep(page, 'One')
  await inspector(page).getByLabel('Title').fill('One v2')
  await page.getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Saved as version 2.')).toBeVisible({ timeout: 20_000 })

  const advance = await page.request.post(`/api/workflows/${id}/versions`, {
    headers: web,
    data: {
      baseVersion: 2,
      definition: {
        name,
        inputs: [],
        nodes: [
          {
            id: 'one',
            kind: 'agent',
            label: 'One v3',
            agentId: 'builder',
            instruction: 'Do it',
            retries: 0,
            onFailure: 'fail_run',
          },
          { id: 'done', kind: 'end', label: 'Done' },
        ],
        edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
      },
    },
  })
  expect(advance.ok()).toBe(true)
  await inspector(page).getByLabel('Title').fill('Mine')
  await page.getByRole('button', { name: 'Save as version 3' }).click()
  const conflict = page.getByRole('alert', { name: 'Someone saved first' })
  await expect(conflict).toBeVisible({ timeout: 20_000 })
  await expect(conflict).toContainText('Version 3')
  await conflict.getByRole('button', { name: /Keep my draft and build on version 3/ }).click()
  await page.getByRole('button', { name: 'Save as version 4' }).click()
  await expect(page.getByText('Saved as version 4.')).toBeVisible({ timeout: 20_000 })

  const details = await openDetails(page)
  await expect(details.getByLabel('Start from an older version')).toBeVisible()
  await inspector(page).getByLabel('Title').fill('Mine, unsaved')
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('unsaved changes')
    await dialog.dismiss()
  })
  await details.getByLabel('Start from an older version').selectOption('1')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Mine, unsaved')
  await expect(page.getByText(/editing version 1/)).toBeHidden()
  await details.getByLabel('Start from an older version').selectOption('')

  page.once('dialog', (dialog) => dialog.accept())
  await details.getByLabel('Start from an older version').selectOption('1')
  await expect(page.getByText(/editing version 1/)).toBeVisible({ timeout: 20_000 })
  await expect(step(page, 'One')).toBeVisible()
  await chooseStep(page, 'One')
  await page.keyboard.press('Control+z')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Mine, unsaved')
  await page.keyboard.press('Control+Shift+z')
  await expect(inspector(page).getByLabel('Title')).toHaveValue('One')
  await page.getByRole('button', { name: 'Save as version 5' }).click()
  await expect(page.getByText('Saved as version 5.')).toBeVisible({ timeout: 20_000 })

  await (await openMore(page)).getByRole('button', { name: 'Export' }).click()
  const exported = page.getByRole('dialog', { name: new RegExp(`Export ${name}`) })
  await expect(exported).toBeVisible({ timeout: 20_000 })
  await expect(exported).toContainText('Version 5 as JSON')
  await expect(exported.locator('pre.orch-pre').last()).toContainText('score.workflow/1')
  await exported.getByRole('button', { name: 'Close' }).click()

  page.once('dialog', (dialog) => dialog.accept())
  await (await openMore(page)).getByRole('button', { name: 'Delete recipe' }).click()
  await expect(page.getByText('Deleted the recipe.')).toBeVisible({ timeout: 20_000 })
  expect((await workflows(page)).some((workflow) => workflow.id === id)).toBe(false)
})

test("a failed live check says it couldn't check the recipe and keeps Save disabled", async ({
  page,
}) => {
  await pair(page)
  await page.route('**/api/workflows/validate', (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'internal', message: 'check failed' } },
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page, 'new')
  // 3.29.0: a new recipe starts with its first step unfinished (the one-line problem), and Score only asks the server once
  // the recipe has no problems of its own.
  await page.locator('[data-node="step1"]').click()
  await inspector(page).getByLabel('Agent').selectOption({ label: 'builder' })
  await inspector(page).getByRole('combobox', { name: 'Instruction' }).fill('Write a short note.')
  await expect(page.getByText("Couldn't check this recipe", { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  // Other tests save versions on the shared fake server, so the number varies.
  await expect(page.getByRole('button', { name: /^Save as version \d+$/u })).toBeDisabled()
})

test('leaving a dirty recipe asks first, and the old addresses land on the page', async ({
  page,
}) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // The library is read from the shared server; pin its list so recipes left by earlier specs cannot delay the built-in card.
  await page.route(
    (url) => url.pathname === '/api/workflows',
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              items: [],
              inventory: {
                definitions: 0,
                versions: 0,
                bytes: 0,
                maxDefinitions: 200,
                maxVersionsPerDefinition: 20,
              },
            },
          })
        : route.fallback(),
  )
  await openRecipes(page, 'new')
  await showText(page)
  await inspector(page).getByLabel('Title').fill('Changed, not saved')

  let accept = false
  page.on('dialog', (prompt) => void (accept ? prompt.accept() : prompt.dismiss()))
  // 3.29.0: "‹ Recipes" is the way back to the library; a dirty draft asks first.
  await page.getByRole('link', { name: '‹ Recipes' }).click()
  await expect(page).toHaveURL(/\/b\/settings\/recipes\/new$/)
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Changed, not saved')

  accept = true
  // The library replaces the page as the click lands, so Playwright's own waits for a stable link would race it.
  await page.getByRole('link', { name: '‹ Recipes' }).click({ noWaitAfter: true, force: true })
  await expect(page).toHaveURL(/\/b\/settings\/recipes$/)
  await expect(page.getByRole('list', { name: 'Recipes', exact: true })).toBeVisible()
  await page
    .getByRole('listitem', { name: /lead decides/ })
    .getByRole('button', { name: /Run in a chat/ })
    .waitFor()

  for (const [from, to] of [
    ['/b?recipes=1', /\/b\/settings\/recipes$/],
    ['/b/workflows?x=1', /\/b\/settings\/recipes\?x=1$/],
    ['/workflows', /\/b\/settings\/recipes$/],
    ['/workflows#step', /\/b\/settings\/recipes#step$/],
    ['/b?recipes=1&job=j1#step', /\/b\/settings\/recipes\?job=j1#step$/],
    ['/b/recipes?x=1', /\/b\/settings\/recipes\?x=1$/],
    ['/b/recipes/lead-decides?x=1', /\/b\/settings\/recipes\/lead-decides\?x=1$/],
  ] as const) {
    await page.goto(from)
    await expect(page).toHaveURL(to)
    if (/lead-decides/.test(String(to)))
      await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
    else await expect(page.getByRole('list', { name: 'Recipes', exact: true })).toBeVisible()
  }
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

test('a saved version opens read-only, Preview plays without running, and Run opens Start a job with the recipe', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = `Versions view ${Date.now().toString(36)}`
  const id = await createViaApi(page, {
    name,
    inputs: [],
    nodes: [
      {
        id: 'one',
        kind: 'agent',
        label: 'One',
        agentId: 'builder',
        instruction: 'Do it',
        retries: 0,
        onFailure: 'fail_run',
      },
      { id: 'done', kind: 'end', label: 'Done' },
    ],
    edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
  })
  await openRecipes(page, id)
  await expect(page.getByRole('textbox', { name: 'Recipe name' })).toHaveValue(name)

  await openMore(page)
  await page.getByLabel('View a saved version (read-only)').selectOption('1')
  await expect(page.getByText('Version 1 (read-only)')).toBeVisible()
  await expect(page.getByRole('button', { name: /Save as version/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /^Add a step/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to my draft' }).click()

  await page.getByRole('button', { name: 'Preview, nothing runs' }).click()
  await expect(page.getByText('Preview: nothing runs, no tokens')).toBeVisible()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('[data-node]').first()).toBeVisible()

  await (await openMore(page)).getByRole('button', { name: 'Run…' }).click()
  await expect(page).toHaveURL(new RegExp(`start=job&recipe=${id}`))
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog.getByRole('radio', { name })).toBeChecked()
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

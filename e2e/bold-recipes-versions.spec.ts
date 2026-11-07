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
  step,
  web,
  workflows,
} from './bold-recipes-helpers.ts'

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

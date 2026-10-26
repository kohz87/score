import { expect, type Page } from '@playwright/test'

// Starting a recipe from the Recipes page (2.8.0): Run… opens Start a job with the recipe chosen, and the run then opens
// on its own page. Shared by the specs that used to start a workflow from the classic list.

const web = { 'x-score-client': 'web' }

export async function recipeIdByName(page: Page, name: string): Promise<string> {
  let id = ''
  await expect(async () => {
    const response = await page.request.get('/api/workflows', { headers: web })
    const found = ((await response.json()) as { items: { id: string; name: string }[] }).items.find(
      (item) => item.name === name,
    )
    expect(found).toBeTruthy()
    id = found!.id
  }).toPass({ timeout: 20_000 })
  return id
}

/** With Start a job open on a recipe: fill its inputs, accept, start, and wait for "Started". */
export async function finishStartJob(page: Page, inputs: Record<string, string> = {}) {
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('version')
  for (const [label, value] of Object.entries(inputs))
    await dialog.getByLabel(new RegExp(`^${label}`)).fill(value)
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start the job' })
  await expect(start).toBeEnabled({ timeout: 30_000 })
  await start.click()
  await expect(dialog.getByRole('heading', { name: 'Started' })).toBeVisible({ timeout: 30_000 })
}

/** Opens the page of the newest run of a recipe. */
export async function openRunOf(page: Page, workflowId: string) {
  let briefId = ''
  await expect(async () => {
    const response = await page.request.get('/api/workflow-runs', { headers: web })
    const run = (
      (await response.json()) as { items: { workflowId: string; briefId: string }[] }
    ).items.find((item) => item.workflowId === workflowId)
    expect(run).toBeTruthy()
    briefId = run!.briefId
  }).toPass({ timeout: 20_000 })
  await page.goto(`/b/runs/${briefId}`)
}

/** Starts a saved recipe by its id from its page and lands on the run. */
export async function startRecipe(page: Page, id: string, inputs: Record<string, string> = {}) {
  await page.goto(`/b/recipes/${id}`)
  await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
  await page.getByRole('button', { name: 'Run…' }).click()
  await finishStartJob(page, inputs)
  await openRunOf(page, id)
}

export async function startRecipeByName(
  page: Page,
  name: string,
  inputs: Record<string, string> = {},
) {
  await startRecipe(page, await recipeIdByName(page, name), inputs)
}

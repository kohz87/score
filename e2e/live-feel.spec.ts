import { expect, test, type Page } from '@playwright/test'
import { releaseDefinition } from './workflow-fixtures.ts'
import { pair } from './pair.ts'
import { startRecipe } from './recipe-run.ts'

// PLAN 5.39 against the fake adapter: no model is called. Status lines, check chips, run summaries, the halo and the
// workflow editor's preview and live overlay.

test.describe.configure({ mode: 'serial' })
const web = { 'x-score-client': 'web' }

async function createWorkflow(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition: { ...releaseDefinition, name } },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

test('the workflow editor previews a gate and a branch without calling the server, and Stop returns to the canvas', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  const id = await createWorkflow(page, `Preview ${Date.now().toString(36)}`)
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && !request.url().endsWith('/api/workflows/validate'))
      posts.push(request.url())
  })
  await page.goto(`/b/recipes/${id}`)
  const preview = page.getByRole('button', { name: 'Preview, nothing runs' })
  await expect(preview).toBeEnabled({ timeout: 20_000 })
  await preview.click()
  await expect(page.getByText('Preview: nothing runs, no tokens')).toBeVisible()
  await page.getByRole('button', { name: '4×' }).click()

  // The first steps light up in order, then the gate waits for a choice.
  const gate = page.getByLabel('Preview: Approve the draft')
  await expect(gate).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="draft"]')).toHaveAttribute('data-state', 'succeeded')
  await expect(page.locator('[data-node="approve"]')).toHaveAttribute('data-state', 'gate')
  await gate.getByRole('button', { name: 'Continue as approved' }).click()

  // The branch asks which outcome to follow; the first rule is chosen by default. Choose "otherwise" instead.
  const branch = page.getByLabel('Preview: Passed review?')
  await expect(branch).toBeVisible({ timeout: 30_000 })
  await expect(branch.getByRole('radio').first()).toBeChecked()
  await branch.getByRole('radio', { name: 'otherwise' }).check()
  await branch.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Preview finished. Nothing ran.')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-node="repair"]')).toHaveAttribute('data-state', 'succeeded')
  await expect(page.locator('[data-node="publish"]')).toHaveAttribute('data-state', 'skipped')

  await page
    .getByRole('region', { name: 'Preview' })
    .getByRole('button', { name: 'Stop', exact: true })
    .click()
  await expect(page.getByText('Preview: nothing runs, no tokens')).toHaveCount(0)
  await expect(page.locator('[data-wf-node="draft"]')).toBeVisible()
  expect(posts).toEqual([])
})

test('the editor draws a run of the version on screen over the canvas and links to it', async ({
  page,
}) => {
  test.setTimeout(150_000)
  await pair(page)
  const name = `Overlay ${Date.now().toString(36)}`
  const id = await createWorkflow(page, name)
  await startRecipe(page, id, { Topic: 'the live overlay' })
  const approve = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(approve).toBeVisible({ timeout: 60_000 })

  // Back in the editor, the run is drawn over the version that is open.
  await page.goto(`/b/recipes/${id}`)
  const live = page.getByText(/Live: run started/)
  await expect(live).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-node="approve"]')).toHaveClass(/orch-node--gate/)
  await expect(page.locator('[data-node="draft"]')).toHaveClass(/orch-node--succeeded/)
  // The draft is untouched.
  await expect(page.getByText(/unsaved changes/)).toHaveCount(0)
  await page.getByRole('link', { name: /Open the run/ }).click()
  await expect(page.getByRole('region', { name: 'Decide on Approve the draft' })).toBeVisible({
    timeout: 30_000,
  })
  // Finish the run: approve the gate (rejecting would stop it).
  const gate = page.getByRole('region', { name: 'Decide on Approve the draft' })
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: 'Approve' }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  // The decided gate stays where it was, as a chip.
  await expect(
    page.getByRole('list', { name: 'Just decided' }).locator('.live-chip--ok'),
  ).toContainText('Approved by you')
})

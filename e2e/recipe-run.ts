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
export interface StartOptions {
  /** Start a job defaults to a $5 spend cap, under which a step of unknown cost pauses; the classic dialog had none. */
  noBudget?: boolean
}

export async function finishStartJob(
  page: Page,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('version')
  for (const [label, value] of Object.entries(inputs))
    await dialog.getByLabel(new RegExp(`^${label}`)).fill(value)
  if (options.noBudget) await dialog.getByLabel(/^Spend cap/).fill('0')
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
  // A run opens in the Runs side panel (2.5.0); its diagram is the Graph tab (callers open it where they need it).
  await page.goto(`/b?run=${encodeURIComponent(briefId)}`)
}

/** Starts a saved recipe by its id from its page and lands on the run. */
export async function startRecipe(
  page: Page,
  id: string,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  await page.goto(`/b/recipes/${id}`)
  await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
  await page.getByRole('button', { name: 'Run…' }).click()
  await finishStartJob(page, inputs, options)
  await openRunOf(page, id)
}

export async function startRecipeByName(
  page: Page,
  name: string,
  inputs: Record<string, string> = {},
  options: StartOptions = {},
) {
  await startRecipe(page, await recipeIdByName(page, name), inputs, options)
}

export const startPolicyA = 'a'.repeat(64)
export const startPolicyB = 'b'.repeat(64)

/**
 * Start a job on a saved plain Hermes recipe whose preflight is answered as if one of its agents were a Codex coding agent
 * with reach beyond its workspace. Nothing is created: the browser's own POST is answered 409 `policy_changed` and its
 * body recorded. `policy.id` is what the next preflight says.
 */
export async function openCodingRecipeStart(page: Page, label: string) {
  // Tests run in parallel on one server: the name must be unique to this test.
  const name = `${label} ${Math.random().toString(36).slice(2, 7)}`
  const created = await page.request.post('/api/workflows', {
    headers: web,
    data: {
      definition: {
        name,
        inputs: [],
        nodes: [
          {
            id: 'one',
            kind: 'agent',
            label: 'First',
            agentId: 'builder',
            instruction: 'Say hello',
            retries: 0,
            onFailure: 'fail_run',
          },
          { id: 'done', kind: 'end', label: 'Done' },
        ],
        edges: [{ id: 'e1', from: 'one', port: 'ok', to: 'done' }],
      },
    },
  })
  expect(created.ok()).toBe(true)
  const id = ((await created.json()) as { workflowId: string }).workflowId
  const policy = { id: startPolicyA }
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/workflow-runs/preflight*', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown> & {
      defaults: Record<string, unknown>
    }
    body.workers = [
      {
        agentId: 'builder',
        runtime: 'codex',
        readiness: 'ready',
        detail: null,
        policyId: policy.id,
        reach:
          'Reads any file you can read, not only the ones in /work/site. It changes files only in /work/site.',
        reachBeyondWorkspace: true,
      },
    ]
    body.defaults = { ...body.defaults, codingSteps: 4 }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/workflow-runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      status: 409,
      json: {
        error: { code: 'policy_changed', message: 'changed', details: { agentId: 'builder' } },
      },
    })
  })
  await page.goto(`/b?start=job&recipe=${id}`)
  const dialog = page.getByRole('dialog', { name: 'Start a job' })
  await expect(dialog.getByRole('radio', { name })).toBeChecked({ timeout: 30_000 })
  return { dialog, bodies, policy, id }
}

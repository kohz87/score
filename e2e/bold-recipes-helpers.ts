import { expect, type Page } from '@playwright/test'

// Shared helpers for the Recipes specs (split from bold-recipes.spec.ts to keep each file under the size limit).
export const web = { 'x-score-client': 'web' }
export const steps = (page: Page) => page.getByRole('list', { name: 'Steps' })
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
export const step = (page: Page, text: string) =>
  steps(page)
    .locator('.bold-step')
    .filter({ has: page.locator('.bold-step-copy > b', { hasText: exact(text) }) })
export const inspector = (page: Page) => page.locator('.bold-rp-aside')

/** The page opens on the graph; the step list is the "As text" tab. */
export async function showText(page: Page) {
  await page.getByRole('tab', { name: 'As text' }).click()
  await expect(steps(page)).toBeVisible()
}

export async function openRecipes(page: Page, id = 'new') {
  await page.goto(`/b/recipes/${id}`)
  await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
}

/** Opens a saved recipe from the library and switches to its step list. */
export async function openRecipeText(page: Page, name: string) {
  // 3.29.0: Settings > Recipes is a library of cards; Edit opens one.
  await page.goto('/b/recipes')
  await page
    .getByRole('listitem', { name, exact: true })
    .getByRole('link', { name: /^Edit/ })
    .click()
  await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
  await showText(page)
}

/** The ⋯ menu (3.29.0: Undo, Redo, Run…, Export, Duplicate, View a version, Archive, Delete): opens it once. */
export async function openMore(page: Page) {
  const dots = page.getByRole('button', { name: 'More' })
  if ((await dots.getAttribute('aria-expanded')) !== 'true') await dots.click()
  return page.getByRole('group', { name: 'More' })
}

export async function openDetails(page: Page) {
  const details = page.locator('.bold-recipes-details')
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator('summary').click()
  return details
}

export async function nameRecipe(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'Recipe name' }).fill(name)
}

export async function chooseStep(page: Page, text: string) {
  await step(page, text).click()
}

export async function createViaApi(page: Page, definition: unknown): Promise<string> {
  const response = await page.request.post('/api/workflows', {
    headers: web,
    data: { definition },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { workflowId: string }).workflowId
}

export async function workflows(page: Page) {
  const response = await page.request.get('/api/workflows', { headers: web })
  expect(response.ok()).toBe(true)
  return (
    (await response.json()) as {
      items: { id: string; name: string; latestVersion: number; versions?: unknown[] }[]
    }
  ).items
}

export async function workflowDetail(page: Page, id: string) {
  const response = await page.request.get(`/api/workflows/${id}`, { headers: web })
  expect(response.ok()).toBe(true)
  return (await response.json()) as {
    latest: {
      definition: { nodes: { id: string }[]; edges: { from: string; port: string; to: string }[] }
    }
  }
}

/** Coding agents in front of the fake team, including one workflow steps must refuse (the classic editor test). */
export async function withCodingAgents(page: Page) {
  await page.route('**/api/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: Record<string, unknown>[] }
    const template = body.items[0]!
    body.items.push(
      ...[
        { id: 'coder-a', runtime: 'codex', shape: 'hexagon', color: '#19C39A' },
        { id: 'coder-b', runtime: 'claude-code', shape: 'triangle', color: '#FFB61E' },
        { id: 'coder-c', runtime: 'antigravity', shape: 'diamond', color: '#6B4EFF' },
      ].map((agent) => ({
        ...template,
        id: agent.id,
        name: agent.id,
        role: 'Coding agent',
        runtime: agent.runtime,
        style: { color: agent.color, shape: agent.shape },
        status: 'idle',
        activity: null,
        served: true,
      })),
    )
    await route.fulfill({ response, json: body })
  })
}

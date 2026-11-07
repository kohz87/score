import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import {
  chooseStep,
  inspector,
  openRecipes,
  showText,
  withCodingAgents,
} from './bold-recipes-helpers.ts'

test('the step list offers coding agents, refuses Antigravity, and Validate keeps Save disabled', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await pair(page)
  await withCodingAgents(page)
  // What the server answers on a computer without supervised coding services (the server tests cover the rule itself).
  await page.route('**/api/workflows/validate', async (route) => {
    const sent = route.request().postDataJSON() as {
      definition: { nodes: { id: string; agentId?: string }[] }
    }
    const coding = sent.definition.nodes.filter((node) => node.agentId?.startsWith('coder-'))
    if (coding.length === 0) return route.fallback()
    await route.fulfill({
      json: {
        ok: false,
        stats: { nodes: sent.definition.nodes.length, edges: 1, maxSteps: 1, bytes: 400 },
        issues: coding.map((node) => ({
          code: 'coding_workers_need_units',
          severity: 'error',
          nodeId: node.id,
          edgeId: null,
          field: 'agentId',
          message:
            'Coding agents can take workflow steps only where Score runs them as supervised system services, and this computer isn’t set up for that right now. Settings › Coding shows what is missing.',
        })),
      },
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page, 'new')
  await showText(page)
  await chooseStep(page, 'First step')
  const picker = inspector(page).getByLabel('Agent')
  await expect(picker.locator('option', { hasText: 'coder-a · Codex' })).not.toHaveAttribute(
    'disabled',
  )
  await expect(picker.locator('option', { hasText: 'coder-b · Claude Code' })).not.toHaveAttribute(
    'disabled',
  )
  const refused = picker.locator('option', { hasText: 'coder-c · Antigravity' })
  await expect(refused).toHaveAttribute('disabled', '')
  await expect(refused).toHaveText(/can’t take workflow steps/)

  await inspector(page).getByRole('combobox', { name: 'Instruction' }).fill('Build the page.')
  await picker.selectOption({ label: 'coder-a · Codex' })
  await expect(inspector(page)).toContainText('Codex works on this computer')
  await expect(page.getByText(/Coding agents can take workflow steps only/)).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByText('Settings › Coding')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save as version 1' })).toBeDisabled()

  await picker.selectOption({ label: 'builder' })
  await expect(page.getByText(/Coding agents can take workflow steps only/)).toBeHidden({
    timeout: 20_000,
  })
  await expect(page.getByRole('button', { name: 'Save as version 1' })).toBeEnabled({
    timeout: 20_000,
  })
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

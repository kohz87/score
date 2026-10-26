import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// These count the team's agents: not while model-picker.spec.ts has one added (locks.ts).
holdLockPerTest('roster')

test('team list opens an agent profile with its cards and a style popover', async ({ page }) => {
  await pair(page)
  await page.goto('/b/team')
  await expect(page.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible()
  await expect(page.locator('.bold-agentcard')).toHaveCount(4)
  await expect(page.getByRole('link', { name: 'builder', exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'builder', exact: true }).first().click()
  await expect(page).toHaveURL('/b/team/builder')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  // The personality file and the skills sit on the page (Skills under More).
  await expect(page.getByText('How builder works')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'SOUL.md contents' })).toBeVisible()
  await page
    .getByRole('button', { name: 'More: memory, skills, tools, workspace, repeating jobs, delete' })
    .click()
  await expect(
    page.locator('#agent-more').getByRole('heading', { name: 'Skills', level: 3 }),
  ).toBeVisible()

  // Saving needs a paired browser, so the request is stubbed; the UI contract is what is checked.
  let body: unknown
  await page.route('**/api/agents/builder/style', async (route) => {
    body = route.request().postDataJSON()
    const agents = await (await page.request.get('/api/agents')).json()
    const builder = agents.items.find((item: { id: string }) => item.id === 'builder')
    await route.fulfill({ json: { ...builder, style: body } })
  })
  await page.getByRole('button', { name: /Change .* colour and shape/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent appearance' })
  await dialog.getByRole('radio', { name: 'star' }).check()
  await dialog.getByRole('button', { name: 'Save appearance' }).click()
  await expect(dialog).toBeHidden()
  expect(body).toMatchObject({ shape: 'star' })
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

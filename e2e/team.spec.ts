import { expect, test } from '@playwright/test'

test('team list opens an agent profile with tabs and a style popover', async ({ page }) => {
  await page.goto('/team')
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible()
  const members = page.getByRole('navigation', { name: 'Team members' })
  await expect(members.getByRole('link')).toHaveCount(5)
  await expect(page.getByRole('heading', { name: 'builder', level: 2 })).toBeVisible()

  await page
    .getByRole('link', { name: /builder/ })
    .first()
    .click()
  await expect(page).toHaveURL('/team/builder')
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personality', level: 2 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Skills', level: 2 })).toBeVisible()

  const overview = page.getByRole('tab', { name: 'Overview' })
  await overview.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Personality' })).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'SOUL.md contents' })).toBeVisible()

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
  await dialog.getByLabel('Shape').selectOption('star')
  await dialog.getByRole('button', { name: 'Save appearance' }).click()
  await expect(dialog).toBeHidden()
  expect(body).toMatchObject({ shape: 'star' })
})

import { expect, test, type Page } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 2.0.10: a local model takes an optional API key, and a key can be added or changed later. Fake adapter only.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

async function openConnections(page: Page) {
  await page.goto('/?ui=bold')
  await expect(page).toHaveURL('/b')
  await page.goto('/b/settings/connections')
  await expect(page.locator('[data-ui="bold"] .setgrid .setnav')).toBeVisible({ timeout: 20_000 })
}

async function addLocal(page: Page, name: string, key?: string) {
  const local = page.locator('[data-provider-id="local"]')
  await local.getByRole('button', { name: 'Add', exact: true }).click()
  const form = local.getByRole('form', { name: 'Add a local model' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Address').fill('http://127.0.0.1:11434/v1')
  await form.getByLabel('Model').fill('local-e2e')
  const field = form.getByLabel('API key (optional)')
  await expect(field).toHaveAttribute('type', 'password')
  await expect(form.getByText(/Only if the server asks for one/)).toBeVisible()
  if (key) await field.fill(key)
  await form.getByRole('button', { name: 'Add model' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()
  return page.locator('[data-provider-id]').filter({ hasText: name })
}

async function removeRow(page: Page, name: string) {
  const row = page.locator('[data-provider-id]').filter({ hasText: name })
  await row.getByRole('button', { name: `Remove ${name}` }).click()
  await row
    .getByRole('group', { name: `Remove ${name}` })
    .getByRole('button', { name: 'Remove', exact: true })
    .click()
  await expect(page.locator('[data-provider-id]').filter({ hasText: name })).toHaveCount(0)
}

for (const viewport of sizes) {
  const where = `${viewport.width}×${viewport.height}`

  test(`a local model added with a key shows Key set at ${where}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await openConnections(page)
    const name = `Keyed ${Date.now().toString(36)}`
    const row = await addLocal(page, name, 'sk-e2e-local-key')
    await expect(row.getByText('Key set')).toBeVisible()
    await expect(row.getByRole('button', { name: `Change key ${name}` })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('sk-e2e-local-key')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
    await removeRow(page, name)
  })

  test(`a local model without a key gets one with Add key at ${where}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await openConnections(page)
    const name = `Plain ${Date.now().toString(36)}`
    const row = await addLocal(page, name)
    await expect(row.getByText('Key set')).toHaveCount(0)
    await row.getByRole('button', { name: `Add key ${name}` }).click()
    await expect(row.locator('.bold-connect-panel')).toHaveAttribute('data-protected', 'block')
    await row.getByLabel('API key', { exact: true }).fill('sk-e2e-later-key')
    await row.getByRole('button', { name: 'Save key' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Key saved for every agent.' }),
    ).toBeVisible()
    await expect(row.getByText('Key set')).toBeVisible()
    await expect(row.getByRole('button', { name: `Change key ${name}` })).toBeVisible()
    await removeRow(page, name)
  })
}

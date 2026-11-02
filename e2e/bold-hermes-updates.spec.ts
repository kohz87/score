import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 3.15.0 (owner): Settings › System › Hermes updates, against the fake adapter's simulated update (it ends in "differs").
const web = { 'x-score-client': 'web' }
const password = 'e2e hermes update password'

// One simulated update job lives on the server, so the two sizes run one after the other.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await pair(page)
  await page.request.put('/api/session/security/password', { headers: web, data: { password } })
})

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`check, update with a test message, then turn approvals on anyway (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/b/settings/system')
    const card = page.getByRole('region', { name: 'Hermes updates' })
    await expect(card.getByText('Update channel')).toBeVisible({ timeout: 30_000 })
    await card.getByRole('button', { name: /Check (for updates|again)/ }).click()
    await card.getByRole('button', { name: 'Update Hermes…' }).click()
    const dialog = page.getByRole('form', { name: 'Update Hermes' })
    await expect(dialog).toHaveAttribute('data-protected', 'block')
    await dialog.getByLabel('Security password').fill('not it')
    await dialog.getByRole('button', { name: 'Back up and update' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('That is not the security password.')
    await dialog.getByLabel('Security password').fill(password)
    await dialog.getByRole('button', { name: 'Back up and update' }).click()
    await expect(page.getByRole('status', { name: 'Update progress' })).toBeVisible()
    await expect(page.getByText('Something Score relies on looks different')).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByText('Session database schema')).toBeVisible()
    await page.getByLabel('Security password').fill(password)
    await page.getByRole('button', { name: 'Turn approvals on anyway' }).click()
    await expect(page.getByText(/Approvals are on for Hermes/)).toBeVisible()
    // No horizontal scroll on the phone.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })
}

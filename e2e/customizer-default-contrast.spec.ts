import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// The default theme must report no contrast problems on any preview page, in either look: a finding here is a real
// unreadable pairing in the shell, or a checker that measures something it should not (a disabled control).
test('the default theme reports no contrast problems on any preview page, light and dark', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/b/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
  await expect(
    page.frameLocator('iframe[title="Preview of your theme"]').locator('[data-ui="bold"]').first(),
  ).toBeVisible({ timeout: 30_000 })
  const checks = page.getByRole('region', { name: 'Contrast checks' })
  const select = page.getByRole('combobox').first()
  const labels = await select.locator('option').allTextContents()
  expect(labels.length).toBeGreaterThan(3)
  for (const mode of ['Dark', 'Light']) {
    await page.getByRole('radio', { name: mode, exact: true }).first().click()
    for (const label of labels) {
      await select.selectOption({ label })
      // The preview paints, then measures; give a failing page time to show its finding.
      await page.waitForTimeout(2500)
      await expect(checks, `${mode} · ${label}`).toContainText('No contrast problems found')
    }
  }
})

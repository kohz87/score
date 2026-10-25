import { expect, test } from '@playwright/test'
import { ACCEPTED_TOKEN, custom, drawn, dropped, wear } from './themes-consent-helpers.ts'

// Cross-audit of v1.8.0 (K1, X7): the full-screen Customizer sits outside both shells; with theme CSS the sanitiser
// accepts, its way back must still be there.

test.describe('X7: the full-screen Customizer keeps its way back', () => {
  test('a theme that fades the Settings link away is not allowed to', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n.cz-back { opacity: 0; color: transparent; }`)
    await page.goto('/settings/look/customize')
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await custom(page)
    await drawn(page.getByRole('link', { name: 'Settings' }))
  })

  test('Ctrl+K opens the command palette with Settings and Reset look, without any shell', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    // The classic view: the bold shell frames the Customizer since 2.0.2.
    await page.addInitScript(() => window.localStorage.setItem('score.ui', 'classic'))
    await wear(page)
    await page.goto('/settings/look/customize')
    await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
    await custom(page)
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search or run a command' })
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
    await palette.getByRole('searchbox').fill('reset look')
    await palette.getByRole('button', { name: 'Reset look on this device' }).click()
    await dropped(page)
  })
})

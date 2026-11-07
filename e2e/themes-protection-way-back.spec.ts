import { expect, test } from '@playwright/test'
import { settle, unreadable, wear } from './themes-protection-helpers.ts'

test.describe('the way back is always reachable (gate #8)', () => {
  const hideSettings =
    '.gear, .icon-btn, button[aria-label="Settings"], .searchbtn, .bold-tabbar button { display: none; opacity: 0; }' +
    'nav[aria-label="Main"] button:last-child { visibility: hidden; }' +
    '[role=dialog] button, [role=dialog] input { display: none; }'

  test('#8: Settings stays on the top bar and “Reset look” in the palette', async ({ page }) => {
    await wear(page, hideSettings)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await settle(page)
    const settings = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    expect(await unreadable(settings)).toEqual([])
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox', { name: 'Search or run a command' }).fill('reset look')
    const reset = palette.getByRole('option', { name: /Reset look on this device/ })
    await expect(reset).toBeVisible()
    expect(await unreadable(reset)).toEqual([])
    await reset.click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('#8: the phone tab bar keeps Settings', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await wear(page, hideSettings)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await settle(page)
    const settings = page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: /Settings/ })
    await expect(settings).toBeVisible()
    expect(await unreadable(settings)).toEqual([])
  })

  test('#8: a theme can’t hide the palette itself', async ({ page }) => {
    await wear(
      page,
      '.bold-search-dialog { display: none; } .bold-search-scrim { display: none; } [role=dialog] { opacity: 0; }',
    )
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    // Either the theme never reached it, or Score noticed and put its own look back.
    await expect(palette).toBeVisible({ timeout: 10_000 })
    await settle(page)
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('combobox', { name: 'Search or run a command' })).toBeVisible()
  })
})

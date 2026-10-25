import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 2.1.3: the terminal icon in the bold top bar opens the web terminal inside the frame; Back returns.

async function offerTerminal(page: Page, terminal: boolean, terminalUnavailable: string | null) {
  await page.route('**/api/session/security', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ json: { passwordSet: true, origins: [], terminal, terminalUnavailable } })
  })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`the Terminal icon opens /b/terminal in the frame and Back returns at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await pair(page)
    await page.setViewportSize(viewport)
    await offerTerminal(page, true, null)
    await page.goto('/b/team')
    const icon = page.getByRole('banner').getByRole('button', { name: 'Terminal' })
    await expect(icon).toBeVisible()
    const box = await icon.boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(36)
    await icon.click()
    await expect(page).toHaveURL(/\/b\/terminal$/)
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '← Back' }).click()
    await expect(page).toHaveURL(/\/b\/team$/)

    await expect(page.getByRole('heading', { name: 'Terminal' })).toHaveCount(0)
    // Ctrl+` toggles too, and the classic address lands in the frame.
    await page.keyboard.press('Control+Backquote')
    await expect(page).toHaveURL(/\/b\/terminal$/)
    await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    await expect(page).toHaveURL(/\/b\/team$/)
    await page.goto('/terminal')
    await expect(page).toHaveURL(/\/b\/terminal$/)
  })
}

test('no Terminal icon when the server reports the terminal unavailable', async ({ page }) => {
  await pair(page)
  await offerTerminal(page, true, 'The terminal needs HTTPS.')
  await page.goto('/b')
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Terminal' })).toHaveCount(0)
})

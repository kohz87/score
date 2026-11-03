import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 3.18.0: the Screens page against the fake adapter (builder's Bot Desktop runs there).
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const size of sizes) {
  test(`screens from the top bar, open a screen, take over (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size)
    await pair(page)
    await page.goto('/b?open=1')
    // Phone: the top bar's pills; desktop: the main navigation.
    const open =
      size.width < 600
        ? page.getByRole('button', { name: 'Screens', exact: true })
        : page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Screens' })
    await open.click()
    await expect(page).toHaveURL(/\/b\/screens$/)
    await expect(page.getByRole('heading', { name: 'Screens', level: 1 })).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)

    if (size.width < 600) {
      await page.getByRole('link', { name: /^builder, Live desktop/ }).click()
      await expect(page).toHaveURL(/\/b\/screen\/builder$/)
      return
    }

    const card = page.getByRole('article', { name: 'builder’s screen' })
    await expect(card.getByText('Live desktop')).toBeVisible()
    await expect(card.getByRole('link', { name: 'Take over…' })).toBeVisible()

    await card.getByRole('link', { name: 'Open screen' }).click()
    await expect(page).toHaveURL(/\/b\/screen\/builder$/)

    await page.goBack()
    await page
      .getByRole('article', { name: 'builder’s screen' })
      .getByRole('link', { name: 'Take over…' })
      .click()
    await expect(page.getByRole('form', { name: 'Take over builder’s desktop?' })).toBeVisible()
    await expect(page).toHaveURL(/\/b\/screen\/builder$/)
  })
}

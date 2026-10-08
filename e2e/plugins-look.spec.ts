import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Settings › Plugins and look: per-agent plugins toggle, the bridge is locked, theme sticks', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/settings')
  const region = page.getByRole('region', { name: 'Plugins and look' })
  const picker = region.getByLabel('Agent whose plugins to show')
  await picker.selectOption({ label: 'designer' })

  const bridge = region.getByRole('switch', { name: 'score-bridge for designer' })
  await expect(bridge).toBeDisabled()
  await expect(region.getByText(/can't be turned off here/)).toBeVisible()

  const notes = region.getByRole('switch', { name: 'memory-notes for designer' })
  await expect(notes).toHaveAttribute('aria-checked', 'true')
  await notes.click()
  await expect(notes).toHaveAttribute('aria-checked', 'false')
  // Plugins are per profile, and the change survives a reload (it is Hermes state, not page state).
  await page.goto('/settings')
  await region.getByLabel('Agent whose plugins to show').selectOption({ label: 'designer' })
  await expect(region.getByRole('switch', { name: 'memory-notes for designer' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await region.getByLabel('Agent whose plugins to show').selectOption({ label: 'reviewer' })
  await expect(region.getByRole('switch', { name: 'memory-notes for reviewer' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await region.getByLabel('Agent whose plugins to show').selectOption({ label: 'designer' })
  await region.getByRole('switch', { name: 'memory-notes for designer' }).click()
  await expect(region.getByRole('switch', { name: 'memory-notes for designer' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  const html = page.locator('html')
  const groundOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const theme = region.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await groundOf()).toBe('rgb(15, 17, 22)')
  await page.goto('/settings')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')

  // System follows the OS preference.
  await theme.getByRole('radio', { name: 'System' }).click()
  await expect(html).not.toHaveAttribute('data-theme')
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await groundOf()).toBe('rgb(15, 17, 22)')
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await groundOf()).toBe('rgb(236, 238, 242)')
  await theme.getByRole('radio', { name: 'Light' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  expect(await groundOf()).toBe('rgb(236, 238, 242)')
})

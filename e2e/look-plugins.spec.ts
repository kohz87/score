import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Team › agent › Plugins: toggles per agent, the bridge is locked; Settings › Look: theme sticks', async ({
  page,
}) => {
  await pair(page)
  const open = async (agent: string) => {
    await page.goto(`/team/${agent}`)
    await page.getByRole('tab', { name: 'Plugins' }).click()
    return page.getByRole('tabpanel')
  }
  let panel = await open('designer')
  const bridge = panel.getByRole('switch', { name: 'score-bridge for designer' })
  await expect(bridge).toBeDisabled()
  await expect(panel.getByText(/can’t be turned off here/)).toBeVisible()

  const notes = panel.getByRole('switch', { name: 'memory-notes for designer' })
  await expect(notes).toHaveAttribute('aria-checked', 'true')
  await notes.click()
  await expect(notes).toHaveAttribute('aria-checked', 'false')
  // Plugins are per profile, and the change survives a reload (it is Hermes state, not page state).
  panel = await open('designer')
  await expect(panel.getByRole('switch', { name: 'memory-notes for designer' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  panel = await open('reviewer')
  await expect(panel.getByRole('switch', { name: 'memory-notes for reviewer' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  panel = await open('designer')
  await panel.getByRole('switch', { name: 'memory-notes for designer' }).click()
  await expect(panel.getByRole('switch', { name: 'memory-notes for designer' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  await page.goto('/settings')
  const region = page.getByRole('region', { name: 'Look' })
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

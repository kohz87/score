import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// Plugins are Hermes state of one profile (the toggle changes it), so the specs that flip one take the roster lock.
holdLockPerTest('roster')

test('Team › agent › More › Plugins: toggles per agent, the bridge is locked; Settings › Look: colours stick', async ({
  page,
}) => {
  await pair(page)
  const open = async (agent: string) => {
    await page.goto(`/b/team/${agent}`)
    const more = page.getByRole('button', {
      name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
    })
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
    const card = page.locator('#agent-plugins')
    await expect(card.getByRole('heading', { name: 'Plugins' })).toBeVisible()
    return card
  }
  let panel = await open('designer')
  const bridge = panel.getByRole('checkbox', { name: /score-bridge/ })
  await expect(bridge).toBeDisabled()
  await expect(panel.getByText(/Always on: Score needs it to see what it does/)).toBeVisible()

  const notes = panel.getByRole('checkbox', { name: /memory-notes/ })
  await expect(notes).toBeChecked()
  await notes.click()
  await expect(notes).not.toBeChecked()
  // Plugins are per profile, and the change survives a reload (it is Hermes state, not page state).
  panel = await open('designer')
  await expect(panel.getByRole('checkbox', { name: /memory-notes/ })).not.toBeChecked()
  panel = await open('reviewer')
  await expect(panel.getByRole('checkbox', { name: /memory-notes/ })).toBeChecked()
  panel = await open('designer')
  await panel.getByRole('checkbox', { name: /memory-notes/ }).click()
  await expect(panel.getByRole('checkbox', { name: /memory-notes/ })).toBeChecked()

  await page.goto('/b/settings/look')
  const html = page.locator('html')
  const shell = page.locator('[data-ui="bold"]')
  const dark = 'rgb(18, 19, 26)'
  const light = 'rgb(236, 238, 242)'
  const mode = page.getByRole('radiogroup', { name: 'Mode on this device' })
  await mode.getByRole('radio', { name: /^Dark/ }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(shell).toHaveCSS('background-color', dark)
  await page.goto('/b/settings/look')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(mode.getByRole('radio', { name: /^Dark/ })).toHaveAttribute('aria-checked', 'true')

  // Match this device follows the OS preference.
  await mode.getByRole('radio', { name: /^Match this device/ }).click()
  await expect(html).not.toHaveAttribute('data-theme')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(shell).toHaveCSS('background-color', dark)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(shell).toHaveCSS('background-color', light)
  await mode.getByRole('radio', { name: /^Light/ }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(shell).toHaveCSS('background-color', light)
})

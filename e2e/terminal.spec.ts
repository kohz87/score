import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Same password the other specs use on the shared server (the first to set it wins).
const PASSWORD = 'e2e share password'

test('open a terminal, run echo, see the output, close it', async ({ page }) => {
  await pair(page)
  await page.request.put('/api/session/security/password', {
    headers: { 'x-score-client': 'web' },
    data: { password: PASSWORD },
  })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Terminal' })).toBeVisible()
  await expect(page.getByText('enabled', { exact: true })).toBeVisible()

  await page.goto('/terminal')
  await expect(page.getByText(/This is a shell on the Score machine/)).toBeVisible()
  // A wrong password opens nothing.
  await page.getByLabel('Security password').fill('not the password')
  await page.getByRole('button', { name: 'Open terminal' }).click()
  await expect(page.getByRole('alert')).toHaveText('That is not the security password.')

  await page.getByLabel('Security password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Open terminal' }).click()
  const screen = page.getByTestId('terminal-screen')
  await expect(screen).toBeVisible()
  await expect(page.getByText(/as \w+\./)).toBeVisible({ timeout: 15_000 })
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo score-$((40+2))-ok')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText('score-42-ok', { timeout: 15_000 })

  // Settings lists the open terminal; Close ends it.
  const settings = await page.context().newPage()
  await settings.goto('/settings')
  await settings
    .getByRole('list', { name: 'Open terminals' })
    .getByRole('button', { name: 'Close' })
    .click()
  await expect(page.getByText('Closed.')).toBeVisible({ timeout: 15_000 })
  await settings.close()
})

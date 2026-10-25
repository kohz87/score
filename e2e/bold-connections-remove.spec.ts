import { expect, test, type Page } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 2.0.3: removing a provider, tool server or messaging connection from Settings, and "Remove agent…" on the agent
// page. Fake adapter only. The fake keeps its tool servers and messaging rows for the life of the server, so the
// phone run only opens and cancels those confirms; the desktop run removes them (issue-tracker and telegram are
// not used by other specs).
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

async function openSettings(page: Page, section: string) {
  await page.goto('/?ui=bold')
  await expect(page).toHaveURL('/b')
  await page.goto(`/b/settings/${section}`)
  await expect(page.locator('[data-ui="bold"] .setgrid .setnav')).toBeVisible({ timeout: 20_000 })
}

for (const viewport of sizes) {
  const where = `${viewport.width}×${viewport.height}`
  const desktop = viewport.width > 800

  test(`a provider is removed after a plain-words confirm at ${where}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await openSettings(page, 'connections')

    const name = `Remove me ${Date.now().toString(36)}`
    const local = page.locator('[data-provider-id="local"]')
    await local.getByRole('button', { name: 'Add', exact: true }).click()
    const form = local.getByRole('form', { name: 'Add a local model' })
    await expect(form.getByText('Every agent can use it.')).toBeVisible()
    await form.getByLabel('Name').fill(name)
    await form.getByLabel('Address').fill('http://127.0.0.1:11434/v1')
    await form.getByLabel('Model').fill('local-e2e')
    await form.getByRole('button', { name: 'Add model' }).click()
    await expect(page.getByRole('status').filter({ hasText: `Added ${name}.` })).toBeVisible()

    const row = page.locator('[data-provider-id]').filter({ hasText: name })
    await row.getByRole('button', { name: `Remove ${name}` }).click()
    const confirm = row.getByRole('group', { name: `Remove ${name}` })
    await expect(confirm).toBeVisible()
    await expect(confirm).toHaveAttribute('data-protected', 'block')
    await expect(confirm).toContainText(`Removes ${name} from every agent’s Hermes profile.`)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toBeHidden()
    await row.getByRole('button', { name: `Remove ${name}` }).click()
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: `Removed ${name}.` })).toBeVisible()
    await expect(page.locator('[data-provider-id]').filter({ hasText: name })).toHaveCount(0)
  })

  test(`a provider an agent uses is refused with the server's words at ${where}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await openSettings(page, 'connections')
    const showAll = page.getByRole('button', { name: /^Show all \d+ providers$/u })
    if (await showAll.isVisible().catch(() => false)) await showAll.click()
    // The fake's agents all run on the built-in Demo provider.
    const row = page.locator('[data-provider-id="demo"]')
    await row.getByRole('button', { name: 'Remove Demo' }).click()
    await row
      .getByRole('group', { name: 'Remove Demo' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click()
    const alert = row.getByRole('alert')
    await expect(alert).toContainText('Pick another model there first.')
    await expect(alert).toContainText(/uses? Demo\./)
    await expect(row).toBeVisible()
  })

  test(`a tool server's confirm is protected, and removing drops it at ${where}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await openSettings(page, 'tools')
    const id = desktop ? 'issue-tracker' : 'files'
    const row = page.locator(`[data-tool-server="${id}"]`)
    await row.getByRole('button', { name: `Remove ${id}` }).click()
    const confirm = row.getByRole('group', { name: `Remove ${id}` })
    await expect(confirm).toHaveAttribute('data-protected', 'block')
    await expect(confirm).toContainText(
      `Removes ${id} from Hermes. Agents drop it when the gateway restarts.`,
    )
    if (!desktop) {
      await confirm.getByRole('button', { name: 'Cancel' }).click()
      await expect(confirm).toBeHidden()
      await expect(row).toBeVisible()
      return
    }
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(row).toHaveCount(0)
  })

  if (desktop)
    test(`a connected messaging platform can be disconnected at ${where}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await pair(page)
      await openSettings(page, 'connections')
      const row = page.locator('[data-channel="telegram"]')
      await expect(row).toContainText('Connected')
      await row.getByRole('button', { name: 'Disconnect Telegram' }).click()
      const confirm = row.getByRole('group', { name: 'Remove Telegram' })
      await expect(confirm).toHaveAttribute('data-protected', 'block')
      await expect(confirm).toContainText(
        'Clears Telegram’s settings. It disconnects when the gateway restarts.',
      )
      await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(row).toContainText('Not connected')
      await expect(row.getByRole('button', { name: 'Connect Telegram' })).toBeVisible()
    })

  test(`Remove agent… lands on the delete button at ${where}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    await page.goto('/b/team/builder')
    await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Remove agent…' }).click()
    const del = page.getByRole('button', { name: 'Delete agent' })
    await expect(del).toBeVisible()
    await expect(del).toBeFocused()
    await expect(del).toBeInViewport()
  })
}

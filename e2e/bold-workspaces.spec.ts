import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pair } from './pair.ts'

// 3.20.0: Settings › Workspaces (shared folders, agents assigned), the room menu's workspace, and the agent page's
// read-only folder. Fake adapter only; the folder is made under a fresh temp parent.
test.use({ reducedMotion: 'reduce' })
// Both sizes set the one team room's workspace on the shared server, so they take turns.
test.describe.configure({ mode: 'serial' })

async function open(page: Page, url: string) {
  await page.goto('/?ui=bold')
  await expect(page).toHaveURL('/b')
  await page.goto(url)
  await expect(page.locator('[data-ui="bold"]').first()).toBeVisible({ timeout: 20_000 })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const) {
  test(`a workspace is made, shared with an agent and set on a room at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const parent = mkdtempSync(join(tmpdir(), 'score-e2e-ws-'))
    const name = `feed-${viewport.width}-${Date.now().toString(36)}`
    const folder = join(parent, name)

    await open(page, '/b/settings/workspaces')
    await page.getByRole('button', { name: 'New workspace' }).click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByLabel('Folder on this computer').fill(folder)
    // A folder that isn't there is refused until the box is ticked.
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await expect(page.getByRole('alert')).toContainText(/doesn.t exist/)
    await page.getByRole('checkbox', { name: 'Create the folder if it doesn’t exist' }).check()
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const card = page.getByRole('region', { name })
    await expect(card).toBeVisible()
    expect(existsSync(folder)).toBe(true)
    await expect(card.getByText('Not used by a room yet')).toBeVisible()

    // Tick an agent; a Hermes agent can then take the workspace as its folder.
    const lead = card.getByRole('button', { name: 'lead', exact: true })
    await lead.click()
    await expect(lead).toHaveAttribute('aria-pressed', 'true')
    await card.getByRole('button', { name: /Use as lead.s folder/ }).click()
    await expect(card.getByText('lead’s folder')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    )

    // The agent page shows the folder but no longer changes it.
    await open(page, '/b/agents/lead')
    await page
      .getByRole('button', {
        name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
      })
      .click()
    await expect(page.getByRole('link', { name: /Workspaces are set in Settings/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Set folder' })).toHaveCount(0)

    // A room picks it from its menu.
    await open(page, '/b')
    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: /^Workspace:/ }).click()
    await page.getByRole('radio', { name }).check()
    await page.getByRole('button', { name: 'Save' }).click()
    await page.getByRole('button', { name: 'Room menu' }).click()
    await expect(page.getByRole('menuitem', { name: `Workspace: ${name}` })).toBeVisible()
    await page.keyboard.press('Escape')

    await open(page, '/b/settings/workspaces')
    await expect(page.getByRole('region', { name }).getByText('Used by 1 room')).toBeVisible()

    // Delete keeps the folder and clears the room.
    await page.getByRole('region', { name }).getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByText(/The folder stays on disk/)).toBeVisible()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByRole('region', { name })).toHaveCount(0)
    expect(existsSync(folder)).toBe(true)
  })
}

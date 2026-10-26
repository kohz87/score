import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// The team is shared by every spec in the run and others count its agents: hold the roster lock while this one is on it.
holdLockPerTest('roster')

test('add an agent, observe setup and readiness, then export and delete with its typed name', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const id = 'profile-test-helper'
  await pair(page)
  await page.goto('/b/team?add=agent')
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await dialog.getByLabel('Name').fill(id)
  await dialog.getByLabel('What does it do?').fill('Helps the team test profile management')
  await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
  await dialog
    .getByRole('radiogroup', { name: 'Shape' })
    .getByRole('radio', { name: 'hexagon' })
    .click()
  await dialog.getByRole('button', { name: 'Preview changes' }).click()
  await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
  await dialog.getByRole('button', { name: `Add ${id}` }).click()
  await expect(dialog.getByRole('heading', { name: 'Setting up' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible({
    timeout: 20_000,
  })
  try {
    await dialog.getByRole('link', { name: /^Open / }).click()
    await expect(page.getByRole('heading', { name: id, level: 1, exact: true })).toBeVisible()

    // Remove agent… opens the panel in place: what is going on, where the private copy goes, then the typed name.
    await page.getByRole('button', { name: 'Remove agent…' }).click()
    const panel = page.getByRole('group', { name: `Remove ${id}` })
    await expect(panel).toBeVisible()
    await expect(panel.getByText(/leaves out credentials and isn’t a full undo/)).toBeVisible()
    await expect(panel.getByText(/A private copy is kept first:/)).toContainText(
      '/profile-backups/',
    )
    const confirm = panel.getByRole('button', { name: 'Remove', exact: true })
    await expect(confirm).toBeDisabled()
    await panel.getByLabel(`Type ${id} to confirm`).fill('wrong-name')
    await expect(confirm).toBeDisabled()
    await panel.getByLabel(`Type ${id} to confirm`).fill(id)
    await expect(confirm).toBeEnabled()
    await confirm.click()
    // The page leaves for the team once the removal has completed.
    await expect(page).toHaveURL(/\/b\/team$/, { timeout: 30_000 })
    await expect(page.getByRole('link', { name: id, exact: true })).toHaveCount(0)
  } finally {
    // A failed run must not leave the agent on the shared server (global teardown checks).
    await page.evaluate(async (agentId) => {
      const headers = { 'content-type': 'application/json', 'X-Score-Client': 'web' }
      const preview = await fetch('/api/agents/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'delete', agentId }),
      })
      if (!preview.ok) return
      const { hash } = (await preview.json()) as { hash: string }
      await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ typedName: agentId, previewHash: hash }),
      })
    }, id)
  }
})

import { expect, test, type Page } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 2.0.3: removing a provider, tool server or messaging connection from Settings, and "Remove agent…" on the agent
// page (2.0.5: the panel opens in place). Fake adapter only. The fake keeps its tool servers and messaging rows for the life of the server, so the
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
      await expect(row.getByRole('button', { name: 'Connect Telegram', exact: true })).toBeVisible()
    })

  test(`Remove agent… removes a Hermes agent in place, behind its typed name, at ${where}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize(viewport)
    await pair(page)
    const id = `rm-helper-${testInfo.repeatEachIndex}-${testInfo.retry}-${desktop ? 'd' : 'p'}`
    await page.goto('/b/team')
    await page.evaluate(async (agentId) => {
      const headers = { 'content-type': 'application/json', 'X-Score-Client': 'web' }
      const input = {
        id: agentId,
        name: agentId,
        role: 'Exists to be removed',
        style: { color: '#19C39A', shape: 'triangle' },
        model: 'fake-model',
      }
      const preview = await fetch('/api/agents/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'create', ...input }),
      })
      const { hash } = (await preview.json()) as { hash: string }
      const created = await fetch('/api/agents', {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ ...input, previewHash: hash }),
      })
      if (!created.ok) throw new Error(await created.text())
    }, id)
    await expect
      .poll(
        async () => {
          const body = (await (await page.request.get('/api/agents')).json()) as {
            items: { id: string; lifecycle?: { state?: string } }[]
          }
          return body.items.find((agent) => agent.id === id)?.lifecycle?.state ?? 'ready'
        },
        { timeout: 30_000 },
      )
      .toBe('ready')

    // A failed run must not leave the agent on the shared server (global teardown checks): remove it if still there.
    try {
      await page.goto(`/b/team/${id}`)
      await expect(page.getByRole('heading', { name: id, level: 1 })).toBeVisible()
      const open = page.getByRole('button', { name: 'Remove agent…' })
      const fits = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        )
      expect(await fits()).toBe(true)
      await open.click()
      const panel = page.getByRole('group', { name: `Remove ${id}` })
      await expect(panel).toBeVisible()
      await expect(panel).toHaveAttribute('data-protected', 'block')
      await expect(panel).toBeInViewport()
      await expect(panel.getByText(/A private copy is kept first:/)).toBeVisible()
      await expect(panel.getByText(/isn’t a full undo/)).toBeVisible()
      await expect(panel.getByRole('button', { name: 'Cancel' })).toBeFocused()
      expect(await fits()).toBe(true)

      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
      await expect(open).toBeFocused()

      await open.click()
      const remove = panel.getByRole('button', { name: 'Remove', exact: true })
      await expect(remove).toBeDisabled()
      await panel.getByLabel(`Type ${id} to confirm`).fill('wrong-name')
      await expect(remove).toBeDisabled()
      await panel.getByLabel(`Type ${id} to confirm`).fill(id)
      await expect(remove).toBeEnabled()
      await remove.click()
      await expect(page).toHaveURL(/\/b\/team$/, { timeout: 30_000 })
      await expect(page.getByRole('link', { name: id, exact: true })).toHaveCount(0)
    } finally {
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

  test(`Remove agent… on a coding agent asks in plain words and removes it at ${where}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await pair(page)
    const id = `rm-coder-${testInfo.repeatEachIndex}-${testInfo.retry}-${desktop ? 'd' : 'p'}`
    await page.goto('/b/team')
    await page.evaluate(async (agentId) => {
      const response = await fetch('/api/coding-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify({
          id: agentId,
          name: agentId,
          role: 'Exists to be removed',
          runtime: 'codex',
          permission: 'workspace-write',
          style: { color: '#6B4EFF', shape: 'hexagon' },
          acknowledgeReads: true,
        }),
      })
      if (!response.ok) throw new Error(await response.text())
    }, id)
    await page.goto(`/b/team/${id}`)
    await expect(page.getByRole('heading', { name: id, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Remove agent…' }).click()
    const panel = page.getByRole('group', { name: `Remove ${id}` })
    await expect(panel).toHaveAttribute('data-protected', 'block')
    await expect(panel).toContainText(`Removes ${id} from the team. Past work stays in rooms.`)
    await panel.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page).toHaveURL(/\/b\/team$/, { timeout: 15_000 })
  })
}

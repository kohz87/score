import { expect, test, type Page } from '@playwright/test'
import { sampleProfile } from '../apps/server/test/helpers/tar.ts'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// PLAN 11.8c: every Add an agent path on the bold shell, against the fake adapter. The demo roster is shared by specs,
// so each test takes the roster lock and removes what it created.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')
test.describe.configure({ mode: 'serial' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const suffix = () => Date.now().toString(36)

async function deleteProfile(page: Page, id: string) {
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

async function deleteCoding(page: Page, id: string) {
  await page.evaluate(async (agentId) => {
    await fetch(`/api/coding-agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: { 'X-Score-Client': 'web' },
    })
  }, id)
}

async function openAdd(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await pair(page)
  await page.goto('/b/team?add=agent')
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await expect(dialog.getByRole('heading', { name: 'Add an agent' })).toBeVisible()
  return dialog
}

for (const viewport of sizes) {
  test(`new agent: shape, colour, preview and setup at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `new-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      const shapeGroup = dialog.getByRole('radiogroup', { name: 'Shape' })
      await expect(shapeGroup.getByRole('radio')).toHaveCount(20)
      await expect(
        dialog.getByRole('radio', { name: /Colour #19c39a, used by builder/ }),
      ).toBeDisabled()

      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Finds sources and writes a short summary.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await shapeGroup.getByRole('radio', { name: 'star' }).click()
      await dialog.getByRole('radio', { name: 'Colour #2bb3c0' }).click()

      const preview = dialog.getByRole('img', { name: `${id}, star` })
      await expect(preview).toBeVisible()
      expect(
        await preview.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--glyph-color').trim(),
        ),
      ).toBe('#2bb3c0')

      await dialog.getByRole('button', { name: 'Preview changes' }).click()
      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      await expect(dialog.getByText('Create profile ' + id)).toBeVisible()
      await dialog.getByRole('button', { name: `Add ${id}` }).click()
      await expect(dialog.getByRole('heading', { name: 'Setting up' })).toBeVisible()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText(/fake-model/)).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`copy from builder: inherited preview and confirmation at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `copy-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Reviews the queue compared by builder.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await dialog.getByLabel('Copy from').selectOption('builder')
      await dialog.getByRole('button', { name: 'Preview changes' }).click()

      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      await expect(dialog.getByText('Memories')).toBeVisible()
      await expect(dialog.getByText('Skills')).toBeVisible()
      const add = dialog.getByRole('button', { name: `Add ${id}` })
      await expect(add).toBeDisabled()
      await dialog.getByRole('checkbox', { name: /what this agent inherits/ }).check()
      await expect(add).toBeEnabled()
      await add.click()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText(`copied from builder`)).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`import a profile: upload progress, credentials and done at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `import-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByRole('radio', { name: /Bring in a Hermes profile/ }).click()
      await page.route('**/api/agents/imports', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        await new Promise((resolve) => setTimeout(resolve, 600))
        await route.continue()
      })
      await dialog.getByLabel('Profile export').setInputFiles({
        name: 'scout.tar.gz',
        mimeType: 'application/gzip',
        buffer: sampleProfile('scout', [{ name: 'scout/.env', body: 'TOKEN=never-shown' }]),
      })
      await expect(
        dialog.getByRole('status').filter({ hasText: /Uploading|Checking/ }),
      ).toBeVisible()
      await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible()
      await expect(dialog.getByText('example/model-1')).toBeVisible()
      await expect(dialog.getByText(/\.env/)).toBeVisible()
      await expect(dialog.getByText('never-shown')).toHaveCount(0)

      await dialog.getByLabel('Name').fill(id)
      const importButton = dialog.getByRole('button', { name: 'Import agent' })
      await expect(importButton).toBeDisabled()
      await dialog.getByRole('checkbox', { name: /credential files/ }).check()
      await expect(importButton).toBeEnabled()
      await importButton.click()
      await expect(dialog.getByRole('heading', { name: 'Importing agent' })).toBeVisible()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText('Hermes agent, imported from an archive')).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`coding tool: install state, version check and acknowledgement at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `coder-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByRole('radio', { name: /A coding tool/ }).click()
      await expect(dialog.getByText(/Installed · version 2\.1\.295/)).toBeVisible()
      await expect(dialog.getByText(/tested by Score/)).toBeVisible()
      const checked = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/coding-agents/runtimes') &&
          response.request().method() === 'GET',
      )
      await dialog.getByRole('button', { name: 'Check version again' }).click()
      await checked

      await dialog.getByRole('radio', { name: 'Codex' }).click()
      const ack = dialog.getByRole('checkbox', { name: /can read any file/ })
      await expect(ack).toBeVisible()
      await expect(ack).toHaveAttribute('data-protected', 'any')
      await dialog.getByRole('radio', { name: /Full access/ }).check()
      await expect(dialog.getByLabel('Security password')).toHaveAttribute('data-protected', 'any')
      await dialog.getByRole('radio', { name: /Workspace write/ }).check()

      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Reviews build scripts.')
      await ack.check()
      const add = dialog.getByRole('button', { name: 'Add coding agent' })
      await expect(add).toBeEnabled()
      await add.click()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 30_000,
      })
      await expect(dialog.getByText(/Codex/)).toBeVisible()
      await expect(dialog.getByText(/workspace write/)).toBeVisible()
      created = true
    } finally {
      if (created) await deleteCoding(page, id)
    }
  })
}

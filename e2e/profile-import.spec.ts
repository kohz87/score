import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'
import { sampleProfile, tarGz } from '../apps/server/test/helpers/tar.ts'

// The imported agent joins the shared demo team for a moment: hold the roster lock (see locks.ts).
holdLockPerTest('roster')

test('import an exported agent: inspect, refuse an existing id, then run the durable steps', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const id = 'imported-scout'
  await pair(page)
  await page.goto('/b/team?add=agent')
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await dialog.getByRole('radio', { name: /Bring in a Hermes profile/ }).click()

  try {
    // An unsafe archive is refused with a reason and nothing is kept.
    await dialog.getByLabel('Profile export').setInputFiles({
      name: 'bad.tar.gz',
      mimeType: 'application/gzip',
      buffer: tarGz([{ name: 'x/' }, { name: 'x/link', type: '2', link: '/etc/passwd' }]),
    })
    await expect(dialog.getByRole('alert')).toContainText(/links, devices or special files/)

    await dialog.getByLabel('Profile export').setInputFiles({
      name: 'scout.tar.gz',
      mimeType: 'application/gzip',
      buffer: sampleProfile('scout', [{ name: 'scout/.env', body: 'TOKEN=never-shown-value' }]),
    })
    await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible()
    await expect(dialog.getByText('example/model-1')).toBeVisible()
    await expect(dialog.getByText('research/web')).toBeVisible()
    await expect(dialog.getByText('.env', { exact: true })).toBeVisible()
    await expect(dialog.getByText('never-shown-value')).toHaveCount(0)
    await expect(dialog.getByLabel('Name')).toHaveValue('scout')
    await dialog.screenshot({
      path: process.env.SCORE_IMPORT_SHOT ?? 'test-results/import-preview.png',
    })

    const submit = dialog.getByRole('button', { name: 'Import agent' })
    await dialog.getByLabel('What does it do?').fill('Looks things up and reports back')
    await expect(submit).toBeDisabled()
    await dialog.getByRole('checkbox', { name: /credential files/ }).check()
    await expect(submit).toBeEnabled()

    // An id already in the team is refused in the form.
    await dialog.getByLabel('Name').fill('lead')
    await expect(dialog.getByText(/already exists/)).toBeVisible()
    await expect(submit).toBeDisabled()

    await dialog.getByLabel('Name').fill(id)
    await expect(submit).toBeEnabled()
    await submit.click()
    await expect(dialog.getByRole('heading', { name: 'Importing agent' })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: / joined the team$/ })).toBeVisible({
      timeout: 20_000,
    })
    await dialog.getByRole('link', { name: /^Open / }).click()
    await expect(page.getByRole('heading', { name: id, level: 1, exact: true })).toBeVisible()
  } finally {
    // The demo team is shared by every spec in the run: delete the imported agent again.
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

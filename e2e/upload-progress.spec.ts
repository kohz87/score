import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { sampleProfile } from '../apps/server/test/helpers/tar.ts'

test('agent import shows the upload, then "Checking the archive…", before the preview', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/team')
  // Hold the answer back so the progress is on screen long enough to see.
  await page.route('**/api/agents/imports', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.continue()
  })
  await page.getByRole('button', { name: 'Import agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import agent' })
  await dialog.getByLabel('Archive').setInputFiles({
    name: 'scout.tar.gz',
    mimeType: 'application/gzip',
    buffer: sampleProfile('scout', []),
  })
  await expect(dialog.getByRole('status')).toContainText(/Uploading · \d+%|Checking the archive…/)
  await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveCount(0)
  // Leaving the preview deletes the stored upload.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

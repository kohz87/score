import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { sampleProfile, tarGz } from '../apps/server/test/helpers/tar.ts'

test('import an exported agent: inspect, refuse an existing id, then run the durable steps', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Import agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import agent' })

  // An unsafe archive is refused with a reason and nothing is kept.
  await dialog.getByLabel('Archive').setInputFiles({
    name: 'bad.tar.gz',
    mimeType: 'application/gzip',
    buffer: tarGz([{ name: 'x/' }, { name: 'x/link', type: '2', link: '/etc/passwd' }]),
  })
  await expect(dialog.getByRole('alert')).toContainText(/links, devices or special files/)

  await dialog.getByLabel('Archive').setInputFiles({
    name: 'scout.tar.gz',
    mimeType: 'application/gzip',
    buffer: sampleProfile('scout', [{ name: 'scout/.env', body: 'TOKEN=never-shown-value' }]),
  })
  await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible()
  await expect(dialog.getByText('example/model-1')).toBeVisible()
  await expect(dialog.getByText('research/web')).toBeVisible()
  await expect(dialog.getByText('.env', { exact: true })).toBeVisible()
  await expect(dialog.getByText('never-shown-value')).toHaveCount(0)
  await expect(dialog.getByLabel('New agent id')).toHaveValue('scout')
  await dialog.screenshot({
    path: process.env.SCORE_IMPORT_SHOT ?? 'test-results/import-preview.png',
  })

  const submit = dialog.locator('button.team-primary')
  await expect(submit).toBeDisabled()
  await dialog.getByRole('checkbox', { name: /credential files/ }).check()
  await expect(submit).toBeEnabled()

  // An id already in the team is refused in the form.
  await dialog.getByLabel('New agent id').fill('lead')
  await expect(dialog.getByText(/already exists/)).toBeVisible()
  await expect(submit).toBeDisabled()

  await dialog.getByLabel('New agent id').fill('imported-scout')
  await submit.click()
  await expect(dialog.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
  await expect(page.getByRole('heading', { name: 'imported-scout', exact: true })).toBeVisible()

  // The demo team is shared by every spec in the run: delete the imported agent again (Team counts and screenshots).
  await page.getByRole('button', { name: 'Delete agent', exact: true }).click()
  await page.getByLabel('Type imported-scout to confirm').fill('imported-scout')
  await page.getByRole('button', { name: 'Confirm deletion' }).click()
  await expect(page.getByRole('heading', { name: 'Agent removed' })).toBeVisible()
})

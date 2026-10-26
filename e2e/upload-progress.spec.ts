import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { sampleProfile } from '../apps/server/test/helpers/tar.ts'

test('agent import shows a real upload percentage while the archive is sent, then the preview', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/b/team?add=agent')
  // A few MB of data that does not compress, sent over a slow link, so the browser reports real progress.
  const archive = sampleProfile('scout', [
    { name: 'scout/memories/big.bin', body: randomBytes(3 * 1024 * 1024) },
  ])
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const link = (bytesPerSecond: number) =>
    cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: bytesPerSecond,
    })
  await link(400 * 1024)
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await dialog.getByRole('radio', { name: /Bring in a Hermes profile/ }).click()
  await dialog.getByLabel('Profile export').setInputFiles({
    name: 'scout.tar.gz',
    mimeType: 'application/gzip',
    buffer: archive,
  })
  // Not "Uploading · 0%", which shows before any byte is out: a real percentage while the archive is still on its way.
  await expect(dialog.getByRole('status').filter({ hasText: /Uploading/ })).toContainText(
    /Uploading · [1-9]\d*%/,
    {
      timeout: 20_000,
    },
  )
  await expect(dialog.getByRole('heading', { name: 'In this archive' })).toHaveCount(0)
  await link(-1)
  await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(dialog.getByRole('status')).toHaveCount(0)
  // Leaving the preview deletes the stored upload.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

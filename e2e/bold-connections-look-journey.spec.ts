import { expect, test } from '@playwright/test'
import {
  addToolServer,
  addTriggerThroughFourSteps,
  connectChannel,
  connectProvider,
  exerciseLook,
  expectNoOverflow,
  expectReducedMotion,
  mockCurrency,
  mockSharedLook,
  openBoldSettings,
  rotateTrigger,
  viewports,
} from './bold-connections-look-helpers.ts'
import { pair } from './pair.ts'

test.describe('bold Connections, Tools and Look', () => {
  test.use({ reducedMotion: 'reduce', colorScheme: 'dark' })

  for (const viewport of viewports) {
    test(`works at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const shared = await mockSharedLook(page)
      const currency = await mockCurrency(page)
      await pair(page)

      await openBoldSettings(page, 'connections')
      await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Hermes', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Model providers' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your phone' })).toBeVisible()
      await connectProvider(page, viewport.provider)
      await connectChannel(page, viewport.channel)
      await expectNoOverflow(page, 'Connections')
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-connections-${viewport.width}.png`),
        fullPage: true,
      })

      await openBoldSettings(page, 'tools')
      await expect(page.getByRole('heading', { name: 'Tools and triggers' })).toBeVisible()
      await expect(page.getByText('files', { exact: true })).toBeVisible()
      await addToolServer(page)
      const trigger = await addTriggerThroughFourSteps(page)
      await rotateTrigger(page, trigger)
      const triggerCard = page.locator(`[data-trigger-id="${trigger.id}"]`)
      await triggerCard.getByRole('button', { name: 'Edit' }).click()
      const edit = page.getByRole('dialog', { name: 'Edit trigger' })
      await expect(edit).toHaveAttribute('data-trigger-step', '3')
      await expect(edit.locator('[data-payload-path="id"]')).toHaveCount(1)
      await edit.getByRole('button', { name: 'Next' }).click()
      await edit.getByLabel(/Post with a tool every time/).check()
      await edit.getByLabel('Tool name').fill('add_comment')
      await edit.getByLabel('Arguments template (JSON)').fill('{"id": "{{source.ref}}"}')
      await edit.getByRole('button', { name: 'Save changes' }).click()
      await expect(edit).toBeHidden()
      await expect(triggerCard).toContainText('Reports back with add_comment.')
      await expectNoOverflow(page, 'Tools and triggers')
      await expectReducedMotion(page)
      await page.screenshot({
        path: testInfo.outputPath(`bold-tools-${viewport.width}.png`),
        fullPage: true,
      })
      await triggerCard.getByRole('button', { name: 'Delete' }).click()
      const remove = page.getByRole('alertdialog', { name: 'Delete this trigger?' })
      await remove.getByRole('button', { name: 'Delete trigger' }).click()
      await expect(triggerCard).toHaveCount(0)

      await exerciseLook(page, shared)
      await page.screenshot({
        path: testInfo.outputPath(`bold-look-${viewport.width}.png`),
        fullPage: true,
      })

      // The same pairing card under the bold tokens: the consent surface does not change.
      await page.goto('/pair')
      const frame = page.locator('.bold-pair-page')
      await expect(frame).toBeVisible()
      await expect(frame).toHaveAttribute('data-ui', 'bold')
      await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
      await expect(page.getByText(/Open the pairing link printed/)).toBeVisible()
      await expect(page.locator('.pair-card')).toHaveAttribute('data-protected', 'block')
      await expectNoOverflow(page, 'pairing')
      await page.screenshot({
        path: testInfo.outputPath(`bold-pair-${viewport.width}.png`),
        fullPage: true,
      })

      expect(currency()).toEqual({ code: 'EUR', rate: 0.92 })
    })
  }
})

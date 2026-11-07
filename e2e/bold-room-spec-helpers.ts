import { expect, test, type Page } from '@playwright/test'
import { openBoldJob } from './bold-room-fixtures.ts'

export const roomTestOptions = {
  reducedMotion: 'reduce',
  permissions: ['clipboard-read', 'clipboard-write'] as string[],
}

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

export function forEachRoomViewport(
  register: (at: string, viewport: (typeof sizes)[number]) => void,
) {
  for (const viewport of sizes) {
    const at = `${viewport.width}×${viewport.height}`

    test.describe(at, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(viewport)
      })

      register(at, viewport)
    })
  }
}

/** The composer's destination pill. On a phone it is hidden by design (the pill composer), so read its text, not its visibility. */
export async function expectDestination(page: Page, label: string) {
  await expect(page.locator('.bold-context-bar .bold-context-to')).toContainText(`in ${label}`)
}

export async function openJob(page: Page, title: RegExp) {
  await openBoldJob(page, title)
}

export function message(page: Page, id: string) {
  return page.locator(`[data-message-id="${id}"]`)
}

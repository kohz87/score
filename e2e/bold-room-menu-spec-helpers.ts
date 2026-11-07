import { expect, test, type Locator, type Page } from '@playwright/test'
import { openInfoSection } from './bold-chat-helpers.ts'

export const menuTestOptions = {
  reducedMotion: 'reduce' as const,
  permissions: ['clipboard-read', 'clipboard-write'] as string[],
}

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

export function forEachMenuViewport(
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

export async function openRoomPicker(page: Page) {
  // 3.24.0: a phone's title switcher is gone too; other rooms are one item in the room menu, as on a desktop.
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.getByRole('menuitem', { name: /Older, imported and elsewhere chats/ }).click()
  return page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
}

/** 3.28.0: a phone's finished jobs are Info › Past jobs (the sheet opens on it); Escape closes the sheet again. */
export async function openPhoneJobList(page: Page) {
  await page.getByRole('button', { name: 'Chat info' }).click()
  await openInfoSection(page, 'Past jobs')
}
export const topicRow = (page: Page, title: string) =>
  page
    .locator('.bold-chat-topics a')
    .filter({ has: page.locator('.bold-chat-topic-title', { hasText: new RegExp(`^${title}$`) }) })

// The app's phone composer hides the "to" chip (bold-room.css); the label stays in the DOM.
export async function expectOlderRoomLabel(page: Page) {
  if ((page.viewportSize()?.width ?? 0) > 600) {
    // 3.22.0: the composer's "Older room · @name" chip is gone; the header badge and the context bar say it.
    await expect(page.locator('.roomtitle .bold-room-kind')).toHaveText('Older room')
    await expect(page.getByPlaceholder('Message this room')).toBeVisible()
  } else {
    await expect(page.locator('[data-phone-chat-title]')).toHaveText('#activity-feed')
    await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible()
    await expect(page.getByPlaceholder('Message this room')).toBeAttached()
  }
}

export async function openOlderRoom(page: Page) {
  const picker = await openRoomPicker(page)
  await picker.getByRole('option', { name: /#activity-feed/ }).click()
  await expectOlderRoomLabel(page)
  await expect(page.getByRole('button', { name: 'Start a job' })).toHaveCount(0)
}

/** 3.22.0: each topic's divider in the conversation carries its job menu (there are no job tabs). */
export const topicHead = (page: Page, title: string) =>
  page.getByRole('separator', { name: new RegExp(`^Topic: ${title}(,|$)`) })
export const jobMenu = (page: Page, title: string) =>
  topicHead(page, title).getByRole('button', { name: 'Job menu' })

export async function share(page: Page, title: string) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: `Share ${title}` })).toBeVisible()
  await expect(dialog).toHaveAttribute('data-protected', 'any')
  await dialog.getByLabel('Security password').fill('correct horse')
  await dialog.getByRole('button', { name: 'Create link' }).click()
  await expect(dialog.getByText('https://score.lan/s/ROOM-MENU')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
}

/** 3.8.1 (owner, phone): an open menu sits wholly inside the screen, whichever side its ⋯ button is on. */
export async function onScreen(page: Page, menu: Locator) {
  const box = (await menu.boundingBox())!
  const width = page.viewportSize()!.width
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)
}

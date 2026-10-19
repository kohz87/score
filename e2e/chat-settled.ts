import { expect, type Page } from '@playwright/test'

/**
 * A Chat room is settled for a screenshot when the composer has stopped growing and the thread sits at its end. The
 * composer's context ring arrives from its own request and first speaks about the room lead; once the messages are in
 * it moves to whoever answered last (the fixture's builder). Each step changes the composer's height (50px on a phone,
 * where the ring wraps Send onto its own line) and the thread has to follow it, so a shot taken before then captures a
 * half-built room (no ring, the last lines shifted 50px). It also stands the room stage's members still.
 */
export async function chatSettled(page: Page, replier = 'builder') {
  // The room stage's members wander when the device is Lively (PLAN 10.10); a screenshot needs them where they start.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const ring = page.getByRole('button', { name: new RegExp(`^${replier} context: `) })
  await expect(ring.first()).toBeVisible()
  // Exactly one ring: the lead's earlier one must be gone, not just joined by the replier's.
  await expect(page.getByRole('group', { name: 'Context use' }).getByRole('button')).toHaveCount(1)
  await expect
    .poll(() =>
      page
        .locator('.chat-scroll')
        .evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)),
    )
    .toBeLessThanOrEqual(1)
}

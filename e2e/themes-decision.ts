import { expect, type Locator, type Page } from '@playwright/test'
import { openBoldRoomWith, type BoldRoomOptions } from './bold-room-fixtures.ts'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'

// Shared by the theme-safety specs. The decision they protect in the new shell is the Needs-you card of a tool approval
// (a protected `.bold-request` article): one card, answered in place with Allow / Don't allow. The room, its approval and
// the decision are contract-shaped fixtures (bold-room-fixtures.ts) so each spec sees the same single card; the theme
// routes are mocked per contract § 16.

/** The Needs-you card of the fixture approval, with its Allow and Don't allow buttons. */
export function approvalCard(page: Page) {
  const card = page.getByRole('article', { name: /^Needs you: May I install a package/ })
  return {
    card,
    allow: card.getByRole('button', { name: 'Allow', exact: true }),
    deny: card.getByRole('button', { name: 'Don’t allow', exact: true }),
  }
}

/**
 * Opens the new shell's room with the fixture approval and `themes` worn; resolves when the card is on the page. No
 * exchange is pending, so the approval is the only decision card.
 */
export async function startApproval(
  page: Page,
  themes: MockTheme[] | null = [],
  look: Look = { active: 'score', mode: 'light' },
  options: BoldRoomOptions = {},
  before?: (page: Page) => Promise<unknown>,
) {
  const state = await openBoldRoomWith(page, { exchanges: [], ...options }, async (frame) => {
    // `null` leaves the theme routes to the real server (the packaged themes).
    if (themes) await mockThemes(frame, themes, look)
    await before?.(frame)
  })
  const parts = approvalCard(page)
  await expect(parts.allow).toBeAttached({ timeout: 20_000 })
  return { ...parts, state }
}

/** Allow on the card ends with the answer shown on it (the fixture has no stream to take the card away). */
export async function allowIt(card: Locator) {
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(card.getByRole('status')).toContainText('Approved', { timeout: 15_000 })
}

/** The topmost element at the middle of `target` is `target` or inside it: nothing covers it. */
export async function isOnTop(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !!top && (element === top || element.contains(top))
  })
}

// The engine confines every theme rule to the outside of protected subtrees (G1 #3); that guard names data-protected
// and is not part of what the theme wrote, so it is taken out before the text is judged.
export async function sheetsText(page: Page): Promise<string> {
  const text = await page.evaluate(() =>
    [
      ...document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText)),
      ...[...document.querySelectorAll('style[data-score-look]')].map((s) => s.textContent ?? ''),
    ].join('\n'),
  )
  return text.replaceAll(':where(:not([data-protected], [data-protected] *))', '')
}

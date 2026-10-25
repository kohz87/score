import { expect, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { mockThemes, type Look } from './themes-fixtures.ts'

// Cross-audit of v1.8.0 (K1, X1/X7/X15): every consent a person gives in Score is a decision, and a theme that the
// sanitiser ACCEPTED (nothing here slips in afterwards unless the test says so) can neither hide nor fake any part of it.
// Real forms in Chromium, real submits; every request that would commit something is answered by the spec and counted.

export const ACCEPTED_TOKEN = '.chat-thread { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }'

export async function wear(
  page: Page,
  css = ACCEPTED_TOKEN,
  look: Look = { active: 'gate', mode: 'light' },
) {
  await mockThemes(
    page,
    [{ id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css }],
    look,
  )
  await pair(page)
  return look
}

export const custom = (page: Page) =>
  expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
export const dropped = (page: Page) =>
  expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom', { timeout: 15_000 })

/** What the theme did to a consent part: it must still be drawn, opaque and legible (the page keeps the theme on). */
export async function drawn(part: Locator) {
  await expect(part).toBeVisible()
  const style = await part.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      opacity: computed.opacity,
      color: computed.color,
      display: computed.display,
      // A disabled control keeps looking disabled (protected.css), but never invisible.
      disabled: element.matches(':disabled, [aria-disabled=true]'),
    }
  })
  expect(style.opacity).toBe(style.disabled ? '0.5' : '1')
  expect(style.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  expect(style.display).not.toBe('none')
}

/** The refusal every surface gives: nothing was sent, the theme is off, Score says why. */
export async function expectRefused(page: Page, sent: unknown[]) {
  await expect(page.locator('.look-banner')).toContainText('Nothing was sent', { timeout: 15_000 })
  await dropped(page)
  expect(sent).toEqual([])
}

import { expect, test } from '@playwright/test'
import {
  hostileCss,
  hostileManifest,
  mockThemes,
  type Look,
  type MockTheme,
} from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// PLAN 11.3: the theme protection of PLAN 9 holds on the new shell. A hostile theme can't hide or fade the dock's
// "needs you" ring or the agents' glyphs (colour + shape); later decision surfaces join the same list (AGENTS.md).

const hostile: MockTheme = {
  id: 'hostile',
  name: 'Hostile',
  source: 'imported',
  manifest: hostileManifest,
  css: hostileCss,
}

test('a hostile theme can’t hide the dock’s needs-you ring or the agents’ glyphs on the new shell', async ({
  page,
}) => {
  const look: Look = { active: 'hostile', mode: 'light' }
  await mockThemes(page, [hostile], look)
  await pair(page)
  // An agent waiting on the person: an approval in a room.
  const room = await makeRoom(page, 'bold-protect')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto('/b')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const ring = page.locator('.bold-needs[data-protected]').first()
  await expect(ring).toBeVisible({ timeout: 20_000 })
  const style = await ring.evaluate((el) => {
    const s = getComputedStyle(el)
    return { opacity: s.opacity, visibility: s.visibility, display: s.display, shadow: s.boxShadow }
  })
  expect(style).toMatchObject({ opacity: '1', visibility: 'visible' })
  expect(style.display).not.toBe('none')
  expect(style.shadow).toContain('rgb(236, 236, 241)')
  expect(style.shadow).toContain('rgb(18, 19, 26)')
  // Every dock glyph is drawn: its shape path is visible and unfaded.
  const glyphs = page.locator('[data-ui="bold"] .dock .agent-glyph')
  expect(await glyphs.count()).toBeGreaterThan(0)
  for (const glyph of await glyphs.all()) {
    await expect(glyph).toBeVisible()
    expect(await glyph.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  }
})

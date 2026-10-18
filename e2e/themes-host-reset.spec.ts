import { expect, test } from '@playwright/test'
import { mockThemes, tidyTheme, type Look } from './themes-fixtures.ts'
import { pair } from './pair.ts'

// Gate finding #10: `scripts/score look reset` bumps the server's reset generation (contract § 16, answered here by the
// mock; the command itself and the real route are covered in apps/server/test). A browser that kept its own theme
// and boot cache from before it must drop both, or the host's escape hatch never reaches that device.

test('a device override and boot cache from before a host reset are dropped on the next load', async ({
  page,
}) => {
  const look: Look = { active: 'score', mode: 'light', resetGeneration: 0 }
  await mockThemes(page, [tidyTheme], look)
  await pair(page)
  await page.goto('/now')
  // The owner picked Tidy for this browser (its own choice, kept in localStorage).
  await page.evaluate(() => localStorage.setItem('score.look.device', 'tidy'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('tidy')
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache') ?? '{}').id),
    )
    .toBe('tidy')

  // The host runs `scripts/score look reset`: the shared look is Score again and the generation moves on.
  look.resetGeneration = 1
  await page.reload()
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('score.look.device'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('score.look.generation'))).toBe('1')
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache') ?? '{}').id),
  ).not.toBe('tidy')

  // Staying reset: another reload still shows Score, and a choice made now survives (same generation).
  await page.reload()
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await page.evaluate(() => localStorage.setItem('score.look.device', 'tidy'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
})

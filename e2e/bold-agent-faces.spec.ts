import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 2.2.0 (decision 127): agents have eyes in the new shell only. Fake mode, no model.

test('every glyph on the bold Team page has two blank eyes', async ({ page }) => {
  await pair(page)
  await page.goto('/b/team')
  const cards = page.locator('.bold-agentcard .agent-glyph')
  await expect(cards.first()).toBeVisible()
  const count = await cards.count()
  expect(count).toBeGreaterThan(0)
  for (let index = 0; index < count; index++) {
    await expect(cards.nth(index).locator('.agent-face__socket')).toHaveCount(2)
  }
  // Blank: the sockets are white and there is nothing else drawn on the face.
  const fill = await cards
    .first()
    .locator('.agent-face__socket')
    .first()
    .evaluate((el) => getComputedStyle(el).fill)
  expect(fill).toBe('rgb(255, 255, 255)')
  await expect(page.locator('.bold-agentcard .agent-face circle')).toHaveCount(0)
})

test('the bold Room dock shows eyes too', async ({ page }) => {
  await pair(page)
  await page.goto('/b')
  const dock = page.locator('[data-ui="bold"] .dock .agent-glyph')
  await expect(dock.first()).toBeVisible()
  await expect(dock.first().locator('.agent-face__socket')).toHaveCount(2)
})

test('a classic page keeps eyeless glyphs', async ({ page }) => {
  await pair(page)
  await page.goto('/team')
  await expect(page.locator('.agent-glyph').first()).toBeVisible()
  await expect(page.locator('.agent-face, .agent-glyph__body')).toHaveCount(0)
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })
  test('eyes are static: nothing on a glyph is animating', async ({ page }) => {
    await pair(page)
    await page.goto('/b/team')
    await expect(page.locator('.bold-agentcard .agent-face__socket').first()).toBeVisible()
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target as Element | null
          return target?.closest('.agent-glyph') && a.playState === 'running'
        })
        .map((a) => (a as CSSAnimation).animationName),
    )
    expect(running).toEqual([])
  })
})

test('without reduced motion the glyph eyes do animate (so the test above proves something)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await pair(page)
  await page.goto('/b/team')
  await expect(page.locator('.bold-agentcard .agent-face__socket').first()).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.('.agent-glyph'))
            .length,
      ),
    )
    .toBeGreaterThan(0)
})

test('a lively hero glyph follows the pointer and greets on a click', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await pair(page)
  await page.goto('/b/team/builder')
  const hero = page.locator('.pagehead .agent-glyph')
  await expect(hero).toBeVisible()
  await expect(hero).toHaveAttribute('data-face', /idle|working|resting|needs/u)
  const face = hero.locator('.agent-face')
  const box = (await hero.boundingBox())!
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 5)
  await expect(face).toHaveAttribute('data-following', '')
  const gx = Number(await face.evaluate((el) => (el as SVGElement).style.getPropertyValue('--gx')))
  expect(gx).toBeGreaterThan(0.5)
  await hero.click()
  await expect(hero).toHaveAttribute('data-greeting', '')
  await expect(hero).toHaveAttribute('data-face', 'done')
  await expect(hero.locator('.agent-face__arc')).toHaveCount(2)
  await expect(hero).not.toHaveAttribute('data-greeting', '', { timeout: 3000 })
})

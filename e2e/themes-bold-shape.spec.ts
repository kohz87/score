import { expect, test, type Page } from '@playwright/test'
import { openBoldRoomWith } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'
import { mockThemes, type MockTheme } from './themes-fixtures.ts'

// Decision 133: the Customizer's Shape options (radius, borders, shadows, glass) act on the new shell's cards.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

async function openCard(page: Page, shape: Record<string, unknown> | null) {
  const themes: MockTheme[] = shape
    ? [{ id: 'shaped', name: 'Shaped', source: 'custom', manifest: { shape } }]
    : []
  await mockThemes(page, themes, { active: shape ? 'shaped' : 'score', mode: 'dark' })
  await pair(page)
  await page.goto('/b/settings/system')
  const card = page.locator('[data-ui="bold"] .bold-settings-page .card').first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  if (shape) await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  return card
}

const styleOf = (card: ReturnType<Page['locator']>) =>
  card.evaluate((element) => {
    const s = getComputedStyle(element)
    return {
      radius: s.borderTopLeftRadius,
      border: s.borderTopWidth,
      shadow: s.boxShadow,
      background: s.backgroundColor,
      blur: s.backdropFilter,
    }
  })

for (const viewport of sizes) {
  const where = `${viewport.width}×${viewport.height}`
  test.describe(where, () => {
    test.use({ viewport })

    test('corner roundness scales the cards, pills stay pills', async ({ page }) => {
      const base = await styleOf(await openCard(page, null))
      const sharp = await styleOf(await openCard(page, { radius: 'sharp' }))
      expect(Number.parseFloat(sharp.radius)).toBeLessThan(Number.parseFloat(base.radius) / 2)
      const round = await styleOf(await openCard(page, { radius: 'round' }))
      expect(Number.parseFloat(round.radius)).toBeGreaterThan(Number.parseFloat(base.radius))
      const exact = await styleOf(await openCard(page, { radius: 14 }))
      expect(Number.parseFloat(exact.radius)).toBeLessThan(Number.parseFloat(base.radius))
      const pill = page.locator('[data-ui="bold"] .bold-settings-page .setnav button').first()
      await expect(pill).toBeVisible()
      expect(await pill.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).not.toBe('0px')
    })

    test('borders and shadows change the card edge', async ({ page }) => {
      const none = await styleOf(await openCard(page, { border: 'none', elevation: 'flat' }))
      expect(none.border).toBe('0px')
      expect(none.shadow).toBe('none')
      const strong = await styleOf(
        await openCard(page, { border: 'strong', elevation: 'floating' }),
      )
      expect(strong.border).toBe('2px')
      expect(strong.shadow).not.toBe('none')
    })

    test('glass makes cards translucent with a blur, and leaves decisions solid', async ({
      page,
    }) => {
      const solid = await styleOf(await openCard(page, { surface: 'solid' }))
      expect(solid.blur).toBe('none')
      const glass = await styleOf(await openCard(page, { surface: 'glass' }))
      expect(glass.blur).toContain('blur')
      expect(glass.background).toMatch(/rgba?\(.*(0\.\d+)\)|color\(/)
      // Nothing that asks the person to decide is translucent.
      const translucent = await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-protected]')].filter((el) => {
            const bg = getComputedStyle(el).backgroundColor
            return /rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) && bg !== 'rgba(0, 0, 0, 0)'
          }).length,
      )
      expect(translucent).toBe(0)
    })
  })
}

const glassTheme: MockTheme = {
  id: 'glassy',
  name: 'Glassy',
  source: 'custom',
  manifest: { shape: { surface: 'glass' } },
}

test('glass never makes a decision or anything holding one translucent, and the guard stays quiet', async ({
  page,
}) => {
  await openBoldRoomWith(page, {}, async (frame) => {
    await mockThemes(frame, [glassTheme], { active: 'glassy', mode: 'dark' })
  })
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'glass')
  const request = page.locator('[data-ui="bold"] .bold-request').first()
  await expect(request).toBeVisible()
  const report = await page.evaluate(() => {
    const alpha = (value: string) => {
      const m = value.match(/\/\s*([\d.]+)\)$|rgba\([^)]*,\s*([\d.]+)\)$/)
      return m ? Number(m[1] ?? m[2]) : 1
    }
    const bad: string[] = []
    for (const el of document.querySelectorAll('[data-protected]')) {
      const own = getComputedStyle(el)
      if (alpha(own.backgroundColor) < 1 && own.backgroundColor !== 'rgba(0, 0, 0, 0)')
        bad.push(`own ${el.className}`)
      for (let up = el.parentElement; up; up = up.parentElement) {
        const style = getComputedStyle(up)
        if (style.backdropFilter !== 'none') bad.push(`ancestor ${up.className}`)
      }
    }
    const request = document.querySelector('[data-ui="bold"] .bold-request')
    return {
      bad,
      count: document.querySelectorAll('[data-protected]').length,
      requestAlpha: alpha(getComputedStyle(request!).backgroundColor),
    }
  })
  expect(report.count).toBeGreaterThan(0)
  expect(report.requestAlpha).toBe(1)
  expect(report.bad).toEqual([])
  await expect(page.locator('.look-banner')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
})

for (const viewport of sizes) {
  test(`density scales card padding at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const padding = async (density: string | null) => {
      const card = await openCard(page, density ? { density } : null)
      return Number.parseFloat(await card.evaluate((e) => getComputedStyle(e).paddingTop))
    }
    const base = await padding(null)
    const compact = await padding('compact')
    const airy = await padding('airy')
    expect(compact).toBeLessThan(base)
    expect(airy).toBeGreaterThan(base)
    expect(await padding('comfortable')).toBe(base)
  })
}

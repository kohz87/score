import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 2.0.13: the composer's + menu opens inside the viewport, anchored to the + button, with readable items.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: '1440×900', viewport: { width: 1440, height: 900 } },
  { name: '390×844', viewport: { width: 390, height: 844 } },
] as const

function luminance([r, g, b]: number[]) {
  const c = [r, g, b].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}

async function checkMenu(page: Page, composer: ReturnType<Page['locator']>) {
  const plus = composer.locator('.chat-attach')
  await plus.focus()
  await page.keyboard.press('Enter')
  const menu = composer.locator('.chat-attach-list')
  await expect(menu).toBeVisible()
  const view = page.viewportSize()!
  const plusBox = (await plus.boundingBox())!
  const items = menu.locator('button')
  expect(await items.count()).toBeGreaterThanOrEqual(2)
  const menuBox = (await menu.boundingBox())!
  expect(menuBox.x).toBeGreaterThanOrEqual(0)
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(view.width)
  expect(menuBox.y).toBeGreaterThanOrEqual(0)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(plusBox.y + 1)
  expect(Math.abs(menuBox.x - plusBox.x)).toBeLessThan(24)
  for (let i = 0; i < (await items.count()); i += 1) {
    const item = items.nth(i)
    await expect(item).toBeVisible()
    const box = (await item.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(menuBox.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(menuBox.x + menuBox.width + 1)
    // The item is what is on top at its centre (no ancestor clips or covers it).
    const top = await item.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit === el || el.contains(hit)
    })
    expect(top).toBe(true)
    const colours = await item.evaluate((el) => {
      const parse = (v: string) => (v.match(/[\d.]+/g) ?? []).map(Number)
      let bg = [0, 0, 0, 0]
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if ((c[3] ?? 1) > 0.5) {
          bg = c
          break
        }
      }
      return { fg: parse(getComputedStyle(el).color), bg }
    })
    const [a, b] = [luminance(colours.fg), luminance(colours.bg)]
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  }
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(plus).toBeFocused()
}

for (const { name, viewport } of sizes) {
  test.describe(`+ menu at ${name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
      await pair(page)
    })

    test('team room', async ({ page }) => {
      await page.goto('/b')
      const composer = page.locator('.chat-composer-box--room').first()
      await expect(composer).toBeVisible({ timeout: 20_000 })
      await checkMenu(page, composer)
    })

    test('one to one', async ({ page }) => {
      await page.goto('/b?with=builder')
      const composer = page.locator('#bold-side-panel .chat-composer-box--room').first()
      await expect(composer).toBeVisible({ timeout: 20_000 })
      await checkMenu(page, composer)
    })
  })
}

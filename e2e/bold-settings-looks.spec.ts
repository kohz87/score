import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Every bold Settings section in both looks: classic sections embedded in the bold shell (Rules, Notifications,
// Advanced, System's parts, Security's remote access, Look's currency, Connections' panels) must read as well as the
// bold ones. Against the fake adapter; no model is called.

const sections = [
  'usage',
  'connections',
  'tools',
  'look',
  'rules',
  'notifications',
  'security',
  'advanced',
  'system',
] as const

type Offender = { text: string; tag: string; ratio: number }

/** Every visible text-bearing element of the section: its text colour against what is really behind it. */
async function offenders(page: Page): Promise<Offender[]> {
  return page.locator('.setmain').evaluate((root) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number)
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const lum = ([r = 0, g = 0, b = 0]: number[]) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    const behind = (element: Element) => {
      const layers: number[][] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = parse(getComputedStyle(node).backgroundColor)
        const alpha = layer[3] ?? 1
        if (alpha > 0) layers.push(layer)
        if (alpha > 0.99) break
      }
      let fill = [255, 255, 255]
      for (const [r = 0, g = 0, b = 0, a = 1] of layers.reverse())
        fill = [r, g, b].map((v, k) => v * a + fill[k]! * (1 - a))
      return fill
    }
    const out: { text: string; tag: string; ratio: number }[] = []
    for (const element of root.querySelectorAll('*')) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? '')
        .join(' ')
        .trim()
      if (!own) continue
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue
      if (element.closest('[disabled], [aria-disabled="true"]')) continue
      const text = parse(style.color)
      const alpha = (text[3] ?? 1) * Number(style.opacity)
      const fill = behind(element)
      const mixed = [0, 1, 2].map((k) => (text[k] ?? 0) * alpha + fill[k]! * (1 - alpha))
      const [hi, lo] = [lum(mixed), lum(fill)].sort((a, b) => b - a)
      const ratio = (hi! + 0.05) / (lo! + 0.05)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
      if (ratio < (large ? 3 : 4.5))
        out.push({
          text: own.slice(0, 40),
          tag: element.tagName.toLowerCase(),
          ratio: +ratio.toFixed(2),
        })
    }
    return out
  })
}

// The look the person chose and what the device prefers can differ: the classic tokens follow the device, the bold
// ones follow the look, and a section drawn with the first on the second's ground is what used to fade out.
const cases = [
  { look: 'dark', device: 'dark' },
  { look: 'dark', device: 'light' },
  { look: 'light', device: 'light' },
  { look: 'light', device: 'dark' },
] as const

for (const { look, device } of cases) {
  test.describe(`Settings in the ${look} look on a ${device} device`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: device })

    for (const section of sections) {
      test(`${section} reads well (${look}, ${device} device)`, async ({ page }) => {
        await pair(page)
        await page.addInitScript((value) => localStorage.setItem('score.theme', value), look)
        await page.goto(`/b/settings/${section}`)
        await expect(page.locator('[data-ui="bold"]')).toHaveAttribute('data-look', look)
        const main = page.locator('.setmain')
        await expect(main.locator('h2, h3').first()).toBeVisible({ timeout: 20_000 })
        await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 20_000 })
        // The section's own content, not just its heading, before anything is measured.
        await expect
          .poll(async () => (await main.innerText()).length, { timeout: 20_000 })
          .toBeGreaterThan(150)
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(800)
        expect(await offenders(page)).toEqual([])
        if (section === 'rules' && look === device)
          await expect(main).toHaveScreenshot(`settings-rules-${look}-${device}.png`, {
            animations: 'disabled',
            maxDiffPixelRatio: 0.02,
            mask: [page.locator('time')],
          })
      })
    }
  })
}

import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// 3.7.0: the bold shell on tablets. Portrait tablets (744-834) use the phone shell but must use the width; landscape
// ones use the desktop shell. Touch screens have no hover, so nothing may be reachable only by hovering.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: '768x1024', width: 768, height: 1024 },
  { name: '820x1180', width: 820, height: 1180 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1180x820', width: 1180, height: 820 },
] as const

type Ready = (page: Page) => Promise<void>

const visible =
  (selector: string): Ready =>
  async (page) => {
    await expect(page.locator(selector).first()).toBeVisible({ timeout: 20_000 })
  }

const roomReady: Ready = async (page) => {
  await visible('.bold-room-composer')(page)
  await visible('.bold-phone-job, .bold-job-tabs, .bold-empty-room')(page)
}

const usageReady: Ready = async (page) => {
  await visible('.usage-stats, [aria-label="Usage in numbers"]')(page)
  await expect(page.getByRole('status').filter({ hasText: /loading/i })).toHaveCount(0, {
    timeout: 15_000,
  })
}

const libraryReady: Ready = async (page) => {
  await visible('.bold-library-nav')(page)
  await visible('.bold-library-item, .bold-library-empty-list')(page)
  await expect(page.getByText(/^Opening note/)).toHaveCount(0, { timeout: 15_000 })
}

const screenReady: Ready = async (page) => {
  await visible('.bold-screen-badge')(page)
  await visible('.bold-live-screen-img, .bold-live-screen-line')(page)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('.bold-live-screen-img')
          return img ? img.complete && img.naturalWidth > 0 : true
        }),
      { timeout: 15_000 },
    )
    .toBe(true)
}

const recipesReady: Ready = async (page) => {
  await visible('.bold-rp-list')(page)
  await expect(
    page
      .locator('.bold-rp-row')
      .or(page.getByText(/No saved recipes yet/))
      .first(),
  ).toBeVisible({ timeout: 20_000 })
}

const pages: { name: string; path: string; ready: Ready }[] = [
  { name: 'room', path: '/b', ready: roomReady },
  { name: 'dm', path: '/b?with=builder', ready: visible('.bold-dm-head') },
  { name: 'team', path: '/b/team', ready: visible('.bold-agentcard') },
  { name: 'agent', path: '/b/team/builder', ready: visible('.bold-agent') },
  { name: 'recipes', path: '/b/recipes', ready: recipesReady },
  { name: 'settings', path: '/b/settings', ready: visible('.bold-settings-page') },
  { name: 'usage', path: '/b/settings/usage', ready: usageReady },
  { name: 'screen', path: '/b/screen/builder', ready: screenReady },
  { name: 'library', path: '/b?library=1', ready: libraryReady },
]

/** Other specs on the shared server can leave something that opens the phone's side sheet (a waiting question):
 * close it, so the room underneath is what gets measured. */
async function closeSheet(page: Page) {
  const toggle = page.getByRole('button', { name: 'Open side panel' })
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
}

async function open(page: Page, path: string, ready: Ready) {
  await page.goto(path)
  await ready(page)
  await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.evaluate(() => document.fonts.ready)
}

for (const size of sizes) {
  test.describe(`tablet ${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      hasTouch: true,
      isMobile: false,
    })

    test('touch: message actions are visible and targets are 44px', async ({ page }) => {
      await pair(page)
      await open(page, '/b?with=builder', visible('.bold-dm-head'))
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
      await expect(
        page.locator('.bold-dm-scroll').getByRole('button', { name: 'Copy' }).first(),
      ).toBeVisible()
      await open(page, '/b', roomReady)
      // Landscape shows the room's messages: their actions must be there (no hover) to be measured.
      if (size.width >= 861)
        await expect(
          page.locator('.bold-acts .bold-act').filter({ visible: true }).first(),
        ).toBeVisible()
      for (const control of [
        page
          .locator('.roomhead, .top')
          .locator('.btn.sm, .icon-btn.sm, .chip')
          .filter({ visible: true }),
        // The room's message actions (always shown without hover) are fingers' targets too.
        page.locator('.bold-acts .bold-act').filter({ visible: true }),
      ]) {
        for (const box of await control.evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect()
            return { label: el.textContent || el.getAttribute('aria-label'), h: r.height }
          }),
        ))
          if (box.h > 0) expect(box.h, String(box.label)).toBeGreaterThanOrEqual(43.5)
      }
    })

    test('layout uses the width', async ({ page }) => {
      await pair(page)
      const portrait = size.width < 861
      await open(page, '/b', roomReady)
      if (portrait) {
        // The title's text, the first job card and the composer share a left edge; the header tools and the content
        // share a right edge.
        await closeSheet(page)
        await expect(page.locator('.bold-phone-job').first()).toBeVisible()
        await expect(page.locator('.bold-phone-list-actions')).toBeVisible()
        await expect(page.locator('.bold-room-composer .chat-composer-box--room')).toBeVisible()
        const edges = await page.evaluate(() => {
          const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
          const text = document.querySelector('.roomhead .roomtitle')!
          const range = document.createRange()
          range.selectNodeContents(text)
          const first = rect('.bold-phone-job')
          const composer = rect('.bold-room-composer .chat-composer-box--room')
          return {
            titleLeft: range.getBoundingClientRect().left,
            cardLeft: first.left,
            composerLeft: composer.left,
            cardRight: first.right,
            composerRight: composer.right,
            toolsRight: rect('.bold-phone-list-actions').right,
          }
        })
        expect(Math.abs(edges.titleLeft - edges.cardLeft), 'title vs card').toBeLessThanOrEqual(2)
        expect(
          Math.abs(edges.composerLeft - edges.cardLeft),
          'composer vs card',
        ).toBeLessThanOrEqual(2)
        expect(Math.abs(edges.toolsRight - edges.cardRight), 'tools vs card').toBeLessThanOrEqual(2)
        expect(
          Math.abs(edges.composerRight - edges.cardRight),
          'composer right',
        ).toBeLessThanOrEqual(2)
        expect(edges.cardRight).toBeGreaterThanOrEqual(size.width - 24)

        // The one-to-one's messages and composer fill the sheet: the agent's glyph and the composer share a left edge,
        // the person's bubble, the composer and the header tools a right edge.
        await open(page, '/b?with=builder', visible('.bold-dm-head'))
        const dm = await page.evaluate(() => {
          const rect = (el: Element | null) => el!.getBoundingClientRect()
          const you = document.querySelector(
            '.bold-dm-scroll .chat-message--you .chat-bubble, .bold-dm-scroll .chat-message--you',
          )
          return {
            glyphLeft: rect(document.querySelector('.bold-dm-scroll .agent-glyph')).left,
            composerLeft: rect(document.querySelector('.bold-dm-composer .chat-composer-box--room'))
              .left,
            composerRight: rect(
              document.querySelector('.bold-dm-composer .chat-composer-box--room'),
            ).right,
            bubbleRight: rect(you).right,
            toolsRight: rect(document.querySelector('.bold-dm-head > :last-child')).right,
          }
        })
        expect(Math.abs(dm.glyphLeft - dm.composerLeft), 'glyph vs composer').toBeLessThanOrEqual(2)
        expect(
          Math.abs(dm.bubbleRight - dm.composerRight),
          'bubble vs composer',
        ).toBeLessThanOrEqual(2)
        expect(
          Math.abs(dm.toolsRight - dm.composerRight),
          'header tools vs composer',
        ).toBeLessThanOrEqual(2)

        // Usage numbers sit two to a row.
        await open(page, '/b/settings/usage', usageReady)
        const cards = await page
          .locator('.usage-stats > *')
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
        expect(new Set(cards).size, 'two cards per row').toBe(Math.ceil(cards.length / 2))
      }
    })

    test('no page scrolls sideways; screenshots', async ({ page }, testInfo) => {
      await pair(page)
      for (const where of pages) {
        await open(page, where.path, where.ready)
        const extra = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        )
        expect(extra, `${where.name} at ${size.name}`).toBeLessThanOrEqual(1)
        await page.screenshot({ path: testInfo.outputPath(`${size.name}-${where.name}.png`) })
      }
    })
  })
}

// A big team (the full test run adds a dozen agents) used to squeeze the room title on a portrait tablet: the glyph
// row now wraps under the title, which keeps its place.
test('a big team’s glyph row never moves the room title on a portrait tablet', async ({ page }) => {
  await pair(page)
  await page.setViewportSize({ width: 768, height: 1024 })
  // A long team name too: it wraps inside the header instead of pushing past the actions.
  await page.route(/\/api\/team-room(\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { room: { name: string } }
    await route.fulfill({
      response,
      json: {
        ...body,
        room: { ...body.room, name: 'The platform and release engineering team room' },
      },
    })
  })
  await page.route(/\/api\/agents(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { items: { id: string; name: string }[] }
    const extra = Array.from({ length: 12 }, (_, i) => ({
      ...body.items[0]!,
      id: `extra-${i}`,
      name: `extra-${i}`,
      // The last one needs you: its protected mark must stay visible in the wrapped row.
      ...(i === 11 ? { status: 'waiting' } : {}),
    }))
    await route.fulfill({ response, json: { ...body, items: [...body.items, ...extra] } })
  })
  await open(page, '/b', roomReady)
  await closeSheet(page)
  await expect(page.locator('.bold-phone-job').first()).toBeVisible()
  // The four demo agents plus twelve (more when other specs added agents to the shared server).
  expect(await page.locator('.bold-phone-presence-agent').count()).toBeGreaterThanOrEqual(16)
  const gap = await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('.roomhead .roomtitle')!)
    return Math.abs(
      range.getBoundingClientRect().left -
        document.querySelector('.bold-phone-job')!.getBoundingClientRect().left,
    )
  })
  expect(gap).toBeLessThanOrEqual(2)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)
  const actions = await page.locator('.bold-phone-list-actions').boundingBox()
  expect(actions!.x + actions!.width).toBeLessThanOrEqual(768)
  await expect(page.locator('.bold-phone-presence-agent.needs')).toBeVisible()
})

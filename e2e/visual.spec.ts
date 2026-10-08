import { expect, test, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

const destinations = [
  { name: 'now', path: '/now', ready: '.now-cards' },
  { name: 'chat', path: '/chat/room-activity-feed', ready: '.chat-files' },
  { name: 'tasks', path: '/tasks', ready: '.task-card' },
  { name: 'team', path: '/team', ready: '.team-agent-card' },
  { name: 'agent', path: '/team/builder', ready: '.team-tabs' },
  { name: 'reports', path: '/reports', ready: '.reports-table tbody tr' },
  { name: 'settings', path: '/settings', ready: '.rules-columns' },
]

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    const key = `${url.pathname}${url.search}`
    const fixture = visualFixtures[key]
    expect(fixture, `Missing visual fixture: ${key}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
})

async function open(page: Page, destination: (typeof destinations)[number], width: number) {
  await page.setViewportSize({ width, height: 1100 })
  await page.goto(destination.path)
  if (destination.name === 'chat' && width < 1100)
    await page.getByRole('button', { name: 'Show room details' }).click()
  await expect(page.locator(destination.ready).first()).toBeVisible()
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
}

for (const width of [1440, 390]) {
  for (const destination of destinations) {
    test(`${destination.name} at ${width}px`, async ({ page }) => {
      await open(page, destination, width)
      if (width === 390) await noPageOverflow(page)
      await expect(page).toHaveScreenshot(`${destination.name}-${width}.png`, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
}

for (const width of [1440, 1024, 900]) {
  test(`header stays on one line at ${width}px`, async ({ page }) => {
    await open(page, destinations[2]!, width)
    const centers = await page
      .locator('.brand, .main-nav, .command-trigger, .avatar')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect()
          return rect.y + rect.height / 2
        }),
      )
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1)
    await noPageOverflow(page)
  })
}

test('mobile Chat keeps the room title whole and the Score link below it', async ({ page }) => {
  await open(page, destinations[1]!, 390)
  const heading = page.getByRole('heading', { name: '#activity-feed', level: 1 })
  const box = (await heading.boundingBox())!
  const lineHeight = await heading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  )
  expect(box.height).toBeLessThanOrEqual(lineHeight + 1)
  const link = (await page.getByRole('link', { name: 'See it on the Score' }).boundingBox())!
  expect(link.y).toBeGreaterThan(box.y + box.height)
  await expect(page.locator('.chat-files')).toHaveText(/src\/activity-feed.ts/)
})

test('mobile agent tabs scroll in one row and keyboard focus brings the last tab into view', async ({
  page,
}) => {
  await open(page, destinations[4]!, 390)
  const tabs = page.getByRole('tablist')
  const tops = await tabs
    .getByRole('tab')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
  expect(new Set(tops).size).toBe(1)
  await page.getByRole('tab', { name: 'Overview', exact: true }).focus()
  await page.keyboard.press('End')
  const last = page.getByRole('tab', { name: 'History', exact: true })
  await expect(last).toBeFocused()
  const lastBox = (await last.boundingBox())!
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(390)
  await noPageOverflow(page)
})

test('mobile Reports scrolls columns and retains readable chart type', async ({ page }) => {
  await open(page, destinations[5]!, 390)
  for (const label of [
    'By agent table, scroll to see all columns',
    'Tasks by day chart, scroll to see all days',
  ]) {
    const region = page.getByRole('region', { name: label })
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await region.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  }
  const scale = await page
    .locator('.tasks-by-day__svg')
    .evaluate((element) => (element as SVGSVGElement).getScreenCTM()!.a)
  expect(scale).toBeGreaterThanOrEqual(1)
  await noPageOverflow(page)
})

// Dark theme (Settings › Plugins and look): same pages, same fixtures, theme stored in the browser.
test.describe('dark theme', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
  })
  for (const destination of destinations) {
    test(`${destination.name} in dark at 1440px`, async ({ page }) => {
      await open(page, destination, 1440)
      expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
      await expect(page).toHaveScreenshot(`${destination.name}-dark-1440.png`, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
})

for (const width of [1024, 900, 899, 390]) {
  test(`rules form ${width >= 900 ? 'three columns' : 'one stack'} at ${width}px`, async ({
    page,
  }) => {
    await open(page, destinations[6]!, width)
    const tops = await page
      .locator('.rules-column')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
    expect(new Set(tops).size).toBe(width >= 900 ? 1 : 3)
    await noPageOverflow(page)
  })
}

test('selects use a centered chevron in both light and dark variants', async ({ page }) => {
  await open(page, destinations[2]!, 1440)
  const select = page.getByRole('combobox', { name: 'Room' })
  const style = () =>
    select.evaluate((element) => {
      const css = getComputedStyle(element)
      return {
        appearance: css.appearance,
        image: css.backgroundImage,
        position: css.backgroundPosition,
        padding: css.paddingRight,
      }
    })
  const dark = await style()
  expect(dark.appearance).toBe('none')
  expect(dark.image).toContain('%23FFFFFF')
  expect(dark.position).toContain('50%')
  expect(dark.padding).toBe('40px')
  await select.selectOption('room-activity-feed')
  const light = await style()
  expect(light.image).toContain('%2312131A')
  await select.focus()
  expect(await select.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid')
})

import { expect, test, type Page } from '@playwright/test'
import { chatSettled } from './chat-settled.ts'
import { fixtureNow } from './now-fixture.ts'
import { orchestrationFixtures } from './orchestration-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'
import { watchApprovalFixture, watchFixture, watchOverviewFixture } from './watch-fixture.ts'

// PLAN 5.34: phone (< 600px) and tablet (600-1023px). Every /api call is answered from fixtures, like visual.spec.ts.
const fixtures: Record<string, unknown> = {
  ...visualFixtures,
  '/api/agents/builder/watch?limit=500': watchFixture,
  '/api/agents/builder/watch?limit=1': watchFixture,
  '/api/approvals?status=pending&agent=builder': {
    asOfSeq: 1,
    items: [watchApprovalFixture],
    nextCursor: null,
  },
  '/api/watch/overview': watchOverviewFixture,
}

type Where = { name: string; path: string; ready: string; orchestration?: boolean }
const routes: Where[] = [
  { name: 'chat-list', path: '/chat', ready: '.chat-conversations nav' },
  { name: 'chat-room', path: '/chat/room-activity-feed', ready: '.chat-scroll' },
  { name: 'team', path: '/team', ready: '.team-agent-card' },
  { name: 'agent', path: '/team/builder', ready: '.team-tabs' },
  {
    name: 'knowledge',
    path: '/knowledge/projects/launch-plan.md',
    ready: '.kn-editor-host .cm-content',
  },
  { name: 'reports', path: '/reports', ready: '.reports-table tbody tr' },
  { name: 'settings', path: '/settings', ready: '.settings-content' },
  { name: 'watch', path: '/watch/builder', ready: 'main' },
]

let withOrchestration = false
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.beforeEach(async ({ page }) => {
  withOrchestration = false
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
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture =
      withOrchestration && key in orchestrationFixtures ? orchestrationFixtures[key] : fixtures[key]
    if (fixture === undefined) {
      await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'none' } } })
      return
    }
    await route.fulfill({ json: fixture })
  })
})

async function open(page: Page, where: Where, width: number, height = 900) {
  withOrchestration = where.orchestration === true
  await page.setViewportSize({ width, height })
  await page.goto(where.path)
  await expect(page.locator(where.ready).first()).toBeVisible()
  if (where.name === 'chat-room') await chatSettled(page)
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
}

for (const width of [360, 390, 768, 1023]) {
  test(`no route scrolls sideways at ${width}px`, async ({ page }) => {
    for (const where of routes) {
      await open(page, where, width)
      const extra = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(extra, `${where.name} at ${width}px`).toBeLessThanOrEqual(1)
    }
  })
}

// The drawer opens over Chat, the first destination, so its link is the marked page.
const drawerHome = routes.find((where) => where.name === 'chat-list')!

test.describe('navigation drawer', () => {
  test.beforeEach(async ({ page }) => {
    await open(page, drawerHome, 390)
  })

  test('opens from the hamburger, marks the page, navigates and returns focus', async ({
    page,
  }) => {
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toHaveAttribute('aria-controls', 'nav-drawer')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    const drawer = page.getByRole('dialog', { name: 'Menu' })
    await expect(drawer).toBeVisible()
    const pages = drawer.getByRole('navigation', { name: 'Pages' })
    await expect(pages.getByRole('link', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page')
    for (const title of ['Team', 'Knowledge', 'Reports', 'Settings'])
      await expect(pages.getByRole('link', { name: title })).toBeVisible()
    expect(await page.evaluate(() => document.body.classList.contains('scroll-locked'))).toBe(true)
    await pages.getByRole('link', { name: 'Team' }).click()
    await expect(page).toHaveURL(/\/team$/)
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
    expect(await page.evaluate(() => document.body.classList.contains('scroll-locked'))).toBe(false)
  })

  test('Escape and the backdrop close it; Tab stays inside it', async ({ page }) => {
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    await menu.click()
    const drawer = page.getByRole('dialog', { name: 'Menu' })
    await expect(drawer).toBeVisible()
    for (let index = 0; index < 14; index++) {
      await page.keyboard.press('Tab')
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      )
    }
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
    await menu.click()
    await page.mouse.click(370, 600)
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
  })

  test('the top-bar navigation returns at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  })
})

test('Chat: on a phone the conversation list opens as a drawer next to a room', async ({
  page,
}) => {
  await open(
    page,
    routes.find((r) => r.name === 'chat-room')!,
    390,
  )
  const list = page.getByRole('navigation', { name: 'Rooms' })
  await expect(list).toBeHidden()
  await page.getByRole('button', { name: 'Rooms' }).click()
  await expect(page.getByRole('dialog', { name: 'Rooms' })).toBeVisible()
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  await expect(page.getByRole('button', { name: 'Rooms' })).toBeFocused()
})

test('Settings: the section list collapses into one disclosure', async ({ page }) => {
  await open(
    page,
    routes.find((r) => r.name === 'settings')!,
    390,
  )
  const jump = page.getByRole('button', { name: /Section/ })
  await expect(jump).toHaveAttribute('aria-expanded', 'false')
  await jump.click()
  await page.getByRole('link', { name: 'Look', exact: true }).click()
  await expect(jump).toContainText('Look')
  await expect(page.getByRole('link', { name: 'Look', exact: true })).toBeHidden()
})

// Visual baselines (PLAN 5.34): phone, tablet and one dark phone.
for (const [width, dark] of [
  [390, false],
  [768, false],
  [390, true],
] as const) {
  test.describe(`${width}px ${dark ? 'dark' : 'light'}`, () => {
    for (const where of routes) {
      if (dark && !['chat-room', 'agent'].includes(where.name)) continue
      test(`${where.name}`, async ({ page }) => {
        // Kept classic pages sit in the bold frame on the new shell; their baselines are the classic ones.
        if (['watch'].includes(where.name))
          await page.addInitScript(() => window.localStorage.setItem('score.ui', 'classic'))
        if (dark) await page.addInitScript(() => window.localStorage.setItem('score.theme', 'dark'))
        await open(page, where, width, width < 600 ? 844 : 1024)
        await expect(page).toHaveScreenshot(`${where.name}-${width}${dark ? '-dark' : ''}.png`, {
          fullPage: true,
          animations: 'disabled',
          maxDiffPixelRatio: 0.005,
        })
      })
    }
  })
}

test('drawer open at 390px', async ({ page }) => {
  await open(page, drawerHome, 390, 844)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
  await expect(page).toHaveScreenshot('drawer-390.png', { animations: 'disabled' })
})

import { expect, test, type Page } from '@playwright/test'
import { chatSettled } from './chat-settled.ts'
import { fixtureNow } from './now-fixture.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

const destinations = [
  { name: 'chat', path: '/chat/room-activity-feed', ready: '.chat-files' },
  { name: 'team', path: '/team', ready: '.team-agent-card' },
  { name: 'agent', path: '/team/builder', ready: '.team-tabs' },
  { name: 'reports', path: '/reports', ready: '.reports-table tbody tr' },
  // Settings is one page per section (PLAN 10.1): Rules and approvals and the landing page, Models and keys.
  { name: 'settings', path: '/settings/rules', ready: '.rules-columns' },
  { name: 'settings-models', path: '/settings/models', ready: '.settings-card' },
  { name: 'journey', path: '/reports?tab=journey', ready: '.journey__row' },
  // Last: other tests in this file address destinations by index.
  { name: 'knowledge', path: '/knowledge/projects/launch-plan.md', ready: '.cm-editor' },
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
    // The viewer's time zone (Reports) depends on the machine; fixtures are keyed without it.
    url.searchParams.delete('tz')
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
  if (destination.name === 'chat') await chatSettled(page)
  await expect(page.getByText(/^Loading/)).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready)
  // Script-driven motion (count-ups, an entrance that waits for its library) marks the page until it has landed.
  await expect(page.locator('html[data-motion]')).toHaveCount(0)
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

// An edited message viewed at its middle version (PLAN 5.35): ‹ 2 / 3 › in the bar, the older branch read-only.
for (const width of [1440, 390]) {
  test(`chat shows version 2 of 3 of an edited message at ${width}px`, async ({ page }) => {
    await open(page, destinations[0]!, width)
    // First the latest version, with the control in the message's action row.
    const brief = page.locator('#message-message-brief-0')
    await brief.scrollIntoViewIfNeeded()
    await expect(brief.getByRole('group', { name: 'Message versions' })).toContainText('3 / 3')
    await expect(page).toHaveScreenshot(`chat-version-3-${width}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
    await page.getByRole('button', { name: 'Previous version' }).click()
    await expect(page.getByText('Viewing version 2 of 3')).toBeVisible()
    await expect(page.getByText('Add pagination to the activity feed.')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(`chat-version-2-${width}.png`, {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
}

for (const width of [1440, 1024]) {
  test(`header stays on one line at ${width}px`, async ({ page }) => {
    await open(page, destinations[0]!, width)
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
  await open(page, destinations[0]!, 390)
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
  await open(page, destinations[2]!, 390)
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
  await open(page, destinations[3]!, 390)
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

// Knowledge editor (PLAN 6.8): one live editor with a toolbar. The default look is the `knowledge-*` baselines above;
// these cover Source, an embedded picture, the table tools and the table size picker.
const shot = (name: string) =>
  [name, { fullPage: true, animations: 'disabled' as const, maxDiffPixelRatio: 0.005 }] as const
const editorLooks = [
  [1440, 'light'],
  [390, 'light'],
  [1440, 'dark'],
] as const
for (const [width, scheme] of editorLooks) {
  const suffix = `${scheme === 'dark' ? 'dark-' : ''}${width}`
  const prepare = async (page: Page, path: string, source = false) => {
    await page.addInitScript(
      ([theme, src]) => {
        if (theme === 'dark') window.localStorage.setItem('score.theme', 'dark')
        if (src) window.localStorage.setItem('score.knowledge.source', '1')
      },
      [scheme, source] as const,
    )
    await page.setViewportSize({ width, height: 1100 })
    await page.goto(path)
    await expect(page.locator('.cm-editor')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
  }
  test(`knowledge source at ${width}px ${scheme}`, async ({ page }) => {
    await prepare(page, '/knowledge/projects/launch-plan.md', true)
    await expect(page.locator('.cm-editor.cm-source')).toBeVisible()
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(...shot(`knowledge-source-${suffix}.png`))
  })
  test(`knowledge image at ${width}px ${scheme}`, async ({ page }) => {
    await prepare(page, '/knowledge/projects/ideas.md')
    const picture = page.locator('.cm-lp-image img')
    await expect(picture).toBeVisible()
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBe(360)
    // The data never shows in the editor.
    expect(await page.locator('.cm-content').textContent()).not.toContain('base64')
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(...shot(`knowledge-image-${suffix}.png`))
  })
  test(`knowledge table tools at ${width}px ${scheme}`, async ({ page }) => {
    await prepare(page, '/knowledge/projects/ideas.md')
    await page.locator('.cm-lp-table').getByRole('cell', { name: 'Sample project' }).click()
    await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(...shot(`knowledge-table-${suffix}.png`))
  })
}
test('knowledge table size picker at 1440px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto('/knowledge/projects/ideas.md')
  await expect(page.locator('.cm-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await page.getByRole('button', { name: '4 columns by 3 rows' }).hover()
  await expect(page.getByText('4 × 3')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot(...shot('knowledge-picker-1440.png'))
})

// Knowledge files (PLAN 6.6): the file manager, a document page and the zip question.
for (const width of [1440, 390]) {
  test(`knowledge files at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.goto('/knowledge?files=projects')
    await expect(page.locator('.kn-table')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(`knowledge-files-${width}.png`, {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
  test(`knowledge document at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.goto('/knowledge/projects/q3-budget.pdf')
    await expect(page.locator('.kn-doc-text')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(`knowledge-document-${width}.png`, {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
  test(`knowledge zip question at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 })
    await page.goto('/knowledge?files=projects')
    await page.getByTestId('kn-upload-input').setInputFiles({
      name: 'pack.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK\x03\x04zip'),
    })
    await expect(page.getByRole('dialog', { name: /Zip file/ })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(`knowledge-zip-${width}.png`, {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
}

// The context ring's popover and the delete-room dialog (PLAN 5.36).
for (const width of [1440, 390]) {
  test(`chat context details popover at ${width}px`, async ({ page }) => {
    await open(page, destinations[0]!, width)
    await page
      .getByRole('button', { name: /context: 77 % of 128k/ })
      .first()
      .click()
    await expect(page.getByRole('dialog', { name: /context details/ })).toBeVisible()
    if (width === 390) await noPageOverflow(page)
    await expect(page).toHaveScreenshot(`chat-context-${width}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
  test(`chat delete room dialog at ${width}px`, async ({ page }) => {
    await open(page, destinations[0]!, width)
    if (width < 1100) await page.getByRole('button', { name: 'Rooms' }).click()
    await page.getByRole('button', { name: 'Actions for #activity-feed' }).click()
    await page.getByRole('menuitem', { name: 'Delete room…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete #activity-feed?' })
    await expect(dialog.getByText(/18 messages, 2 attached files/)).toBeVisible()
    await dialog.getByRole('textbox').fill('#activity-feed')
    await expect(page).toHaveScreenshot(`chat-delete-${width}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.005,
    })
  })
}

// Dark theme (Settings › Look): same pages, same fixtures, theme stored in the browser.
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
    await open(page, destinations[4]!, width)
    const tops = await page
      .locator('.rules-column')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
    expect(new Set(tops).size).toBe(width >= 900 ? 1 : 3)
    await noPageOverflow(page)
  })
}
